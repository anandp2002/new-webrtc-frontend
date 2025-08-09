import React, { useRef, useEffect, useState, useCallback } from 'react';

// Dynamically import WebMidi to avoid issues if it's not supported or enabled
let WebMidiInstance = null;

// Constants for drawing the virtual keyboard and animated notes
const KEYBOARD_PROPORTION = 0.55; // Keyboard will occupy 55% of the canvas height
const KEYBOARD_WIDTH_PROPORTION = 0.95; // Keyboard will occupy 95% of the canvas width

// MIDI note numbers for white keys within an octave (C=0, C#=1, D=2, etc.)
const WHITE_KEYS_RELATIVE = [0, 2, 4, 5, 7, 9, 11]; // C, D, E, F, G, A, B
// MIDI note numbers for black keys within an octave. -1 indicates no black key (E/F gap).
const BLACK_KEYS_RELATIVE = [1, 3, -1, 6, 8, 10]; // C#, D#, F#, G#, A#

// Colors for different elements in the visualizer
const NOTE_COLORS = {
  local: '#FFD700', // Gold for notes played by the local user
  remote: '#8A2BE2', // BlueViolet for notes played by remote users
  activeKey: '#4CAF50', // Green for keys currently pressed on the virtual keyboard
  defaultWhiteKey: '#F0F0F0', // Light gray for unpressed white keys
  defaultBlackKey: '#333333', // Dark gray for unpressed black keys
  localTrail: 'rgba(255, 215, 0, 0.8)', // Gold with transparency
  remoteTrail: 'rgba(138, 43, 226, 0.8)', // BlueViolet with transparency
  keyBorder: '#666', // Key border
  blackKeyBorder: '#222', // Black key border
};

// Animation constants
const NOTE_ANIMATION_SPEED = 2.5; // Speed for animation
const NOTE_FADE_TIME = 4000; // Time in milliseconds for notes to fade after key release
const EXPLOSION_DURATION = 800; // Duration of explosion effect in milliseconds
const EXPLOSION_PARTICLE_COUNT = 12; // Number of particles in explosion

// Note dimensions - ensuring minimum 3cm length
const NOTE_MIN_LENGTH_CM = 3; // Minimum note length in centimeters
const PIXELS_PER_CM = 37.8; // Approximate pixels per cm (96 DPI standard)
const NOTE_MIN_LENGTH_PX = NOTE_MIN_LENGTH_CM * PIXELS_PER_CM; // ~113 pixels minimum

/**
 * MidiVisualizer Component: Displays a real-time virtual piano keyboard and animated falling notes.
 * It listens for local MIDI input and remote MIDI messages via Socket.IO.
 */
const MidiVisualizer = ({ socket, roomId, localUserId }) => {
  const canvasRef = useRef(null);
  const activeNotesRef = useRef({});
  const animatedNotesRef = useRef([]);
  const explosionParticlesRef = useRef([]);
  const animationFrameRef = useRef(null);

  // State for managing MIDI connection status
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState([]);

  // Helper function to create explosion particles
  const createExplosion = useCallback((x, y, color, isLocal) => {
    const particles = [];
    for (let i = 0; i < EXPLOSION_PARTICLE_COUNT; i++) {
      const angle = (Math.PI * 2 * i) / EXPLOSION_PARTICLE_COUNT;
      const speed = 2 + Math.random() * 3;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 1.0,
        decay: 0.015 + Math.random() * 0.01,
        size: 3 + Math.random() * 4,
        color: isLocal ? NOTE_COLORS.local : NOTE_COLORS.remote,
        startTime: performance.now(),
      });
    }
    explosionParticlesRef.current.push(...particles);
  }, []);

  // Helper function to get key position and dimensions
  const getKeyInfo = useCallback((midiNote, canvas) => {
    const dynamicKeyHeight = canvas.height * KEYBOARD_PROPORTION;
    const dynamicBlackKeyHeight = dynamicKeyHeight * (2 / 3);
    const BLACK_KEY_WIDTH_RATIO = 0.6;

    const startOctave = 3;
    const endOctave = 5;
    const numOctaves = endOctave - startOctave + 1;
    const totalWhiteKeys = numOctaves * WHITE_KEYS_RELATIVE.length;

    const dynamicWhiteKeyWidth =
      (canvas.width * KEYBOARD_WIDTH_PROPORTION) / totalWhiteKeys;
    const dynamicBlackKeyWidth = dynamicWhiteKeyWidth * BLACK_KEY_WIDTH_RATIO;

    const keyboardWidth = totalWhiteKeys * dynamicWhiteKeyWidth;
    const keyboardXOffset = (canvas.width - keyboardWidth) / 2;

    const blackKeyWhiteKeyIndexMap = {
      1: 0, // C# relates to C
      3: 1, // D# relates to D
      6: 3, // F# relates to F
      8: 4, // G# relates to G
      10: 5, // A# relates to A
    };

    // Check if it's a black key
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
        const relativeNote = BLACK_KEYS_RELATIVE[i];
        if (relativeNote === -1) {
          continue;
        }
        const blackKeyNote = octave * 12 + relativeNote;
        if (blackKeyNote === midiNote) {
          const baseWhiteKeyIndex =
            blackKeyWhiteKeyIndexMap[relativeNote] +
            (octave - startOctave) * WHITE_KEYS_RELATIVE.length;
          const baseWhiteKeyX =
            keyboardXOffset + baseWhiteKeyIndex * dynamicWhiteKeyWidth;

          const blackKeyX =
            baseWhiteKeyX + dynamicWhiteKeyWidth - dynamicBlackKeyWidth / 2;

          return {
            x: blackKeyX,
            width: dynamicBlackKeyWidth,
            height: dynamicBlackKeyHeight,
            isWhite: false,
            keyboardTop: canvas.height - dynamicKeyHeight,
            centerX: blackKeyX + dynamicBlackKeyWidth / 2,
          };
        }
      }
    }

    // Check if it's a white key
    let whiteKeyIndex = 0;
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < WHITE_KEYS_RELATIVE.length; i++) {
        const whiteKeyNote = octave * 12 + WHITE_KEYS_RELATIVE[i];
        if (whiteKeyNote === midiNote) {
          const whiteKeyX =
            keyboardXOffset + whiteKeyIndex * dynamicWhiteKeyWidth;
          return {
            x: whiteKeyX,
            width: dynamicWhiteKeyWidth,
            height: dynamicKeyHeight,
            isWhite: true,
            keyboardTop: canvas.height - dynamicKeyHeight,
            centerX: whiteKeyX + dynamicWhiteKeyWidth / 2,
          };
        }
        whiteKeyIndex++;
      }
    }

    return null;
  }, []);

  // Main drawing function
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate dynamic key dimensions
    const dynamicKeyHeight = canvas.height * KEYBOARD_PROPORTION;
    const dynamicBlackKeyHeight = dynamicKeyHeight * (2 / 3);
    const BLACK_KEY_WIDTH_RATIO = 0.6;

    const startOctave = 3;
    const endOctave = 5;
    const numOctaves = endOctave - startOctave + 1;
    const totalWhiteKeys = numOctaves * WHITE_KEYS_RELATIVE.length;

    const dynamicWhiteKeyWidth =
      (canvas.width * KEYBOARD_WIDTH_PROPORTION) / totalWhiteKeys;
    const dynamicBlackKeyWidth = dynamicWhiteKeyWidth * BLACK_KEY_WIDTH_RATIO;

    const keyboardWidth = totalWhiteKeys * dynamicWhiteKeyWidth;
    const keyboardXOffset = (canvas.width - keyboardWidth) / 2;
    const keyboardTopY = canvas.height - dynamicKeyHeight;

    const blackKeyWhiteKeyIndexMapDraw = {
      1: 0, // C# relates to C
      3: 1, // D# relates to D
      6: 3, // F# relates to F
      8: 4, // G# relates to G
      10: 5, // A# relates to A
    };

    // Update and draw explosion particles
    const currentTime = performance.now();
    explosionParticlesRef.current = explosionParticlesRef.current.filter(
      (particle) => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += 0.1;
        particle.life -= particle.decay;

        if (particle.life <= 0) return false;

        ctx.globalAlpha = particle.life;
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(
          particle.x,
          particle.y,
          particle.size * particle.life,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.globalAlpha = 1;

        return true;
      }
    );

    // Update and draw animated notes
    animatedNotesRef.current = animatedNotesRef.current.filter((note) => {
      const elapsedTime = currentTime - note.startTime;
      let yPos = (elapsedTime * NOTE_ANIMATION_SPEED) / 16.67;

      const keyInfo = getKeyInfo(note.note, canvas);
      if (!keyInfo) return false;

      // Check if note has reached the keyboard
      if (yPos >= keyboardTopY && !note.hasHitKey) {
        activeNotesRef.current = {
          ...activeNotesRef.current,
          [note.note]: { isLocal: note.isLocal, color: note.color },
        };

        createExplosion(
          keyInfo.centerX,
          keyboardTopY,
          note.isLocal ? NOTE_COLORS.local : NOTE_COLORS.remote,
          note.isLocal
        );
        note.hasExploded = true;
        note.explodeTime = currentTime;
        note.hasHitKey = true;
      }

      // Handle fading
      let alpha = 1;
      if (note.hasExploded) {
        const explodeElapsed = currentTime - note.explodeTime;
        alpha = Math.max(0, 1 - explodeElapsed / EXPLOSION_DURATION);
        if (alpha <= 0) {
          const stillActiveNote = animatedNotesRef.current.some(
            (n) =>
              n.note === note.note &&
              n.hasHitKey &&
              !n.hasExploded &&
              n.isLocal === note.isLocal
          );
          if (!stillActiveNote) {
            const newState = { ...activeNotesRef.current };
            delete newState[note.note];
            activeNotesRef.current = newState;
          }
          return false;
        }
      } else if (note.releaseTime && currentTime > note.releaseTime) {
        const fadeElapsed = currentTime - note.releaseTime;
        alpha = Math.max(0, 1 - fadeElapsed / NOTE_FADE_TIME);
        if (alpha <= 0) {
          const stillActiveNote = animatedNotesRef.current.some(
            (n) =>
              n.note === note.note &&
              n.hasHitKey &&
              !n.releaseTime &&
              n.isLocal === note.isLocal
          );
          if (!stillActiveNote) {
            const newState = { ...activeNotesRef.current };
            delete newState[note.note];
            activeNotesRef.current = newState;
          }
          return false;
        }
      }

      if (note.hasExploded && alpha <= 0) return false;

      // Draw the falling note
      const currentNoteWidth = keyInfo.width * 0.8;
      const currentNoteX = keyInfo.centerX - currentNoteWidth / 2;
      const noteHeight = Math.max(NOTE_MIN_LENGTH_PX, Math.min(80, yPos * 0.6));
      const borderRadius = 5;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = note.isLocal
        ? NOTE_COLORS.localTrail
        : NOTE_COLORS.remoteTrail;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(
          currentNoteX,
          yPos - noteHeight,
          currentNoteWidth,
          noteHeight,
          borderRadius
        );
      } else {
        ctx.fillRect(
          currentNoteX,
          yPos - noteHeight,
          currentNoteWidth,
          noteHeight
        );
      }
      ctx.fill();

      // Add gradient effect
      const gradient = ctx.createLinearGradient(
        currentNoteX,
        yPos - noteHeight,
        currentNoteX,
        yPos
      );
      gradient.addColorStop(
        0,
        note.isLocal
          ? `rgba(255, 215, 0, ${alpha * 0.3})`
          : `rgba(138, 43, 226, ${alpha * 0.3})`
      );
      gradient.addColorStop(
        1,
        note.isLocal
          ? `rgba(255, 215, 0, ${alpha})`
          : `rgba(138, 43, 226, ${alpha})`
      );

      ctx.fillStyle = gradient;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(
          currentNoteX,
          yPos - noteHeight,
          currentNoteWidth,
          noteHeight,
          borderRadius
        );
      } else {
        ctx.fillRect(
          currentNoteX,
          yPos - noteHeight,
          currentNoteWidth,
          noteHeight
        );
      }
      ctx.fill();

      ctx.globalAlpha = 1;
      return true;
    });

    // Draw keyboard keys
    // Draw white keys first
    let whiteKeyIndex = 0;
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < WHITE_KEYS_RELATIVE.length; i++) {
        const midiNote = octave * 12 + WHITE_KEYS_RELATIVE[i];
        const x = keyboardXOffset + whiteKeyIndex * dynamicWhiteKeyWidth;
        const y = canvas.height - dynamicKeyHeight;

        ctx.fillStyle = activeNotesRef.current[midiNote]
          ? NOTE_COLORS.activeKey
          : NOTE_COLORS.defaultWhiteKey;
        ctx.fillRect(x, y, dynamicWhiteKeyWidth, dynamicKeyHeight);
        ctx.strokeStyle = NOTE_COLORS.keyBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, dynamicWhiteKeyWidth, dynamicKeyHeight);
        whiteKeyIndex++;
      }
    }

    // Draw black keys
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
        const relativeNote = BLACK_KEYS_RELATIVE[i];
        if (relativeNote === -1) {
          continue;
        }

        const midiNote = octave * 12 + relativeNote;

        const baseWhiteKeyIndex =
          blackKeyWhiteKeyIndexMapDraw[relativeNote] +
          (octave - startOctave) * WHITE_KEYS_RELATIVE.length;
        const baseWhiteKeyX =
          keyboardXOffset + baseWhiteKeyIndex * dynamicWhiteKeyWidth;

        const x =
          baseWhiteKeyX + dynamicWhiteKeyWidth - dynamicBlackKeyWidth / 2;
        const y = canvas.height - dynamicKeyHeight;

        ctx.fillStyle = activeNotesRef.current[midiNote]
          ? NOTE_COLORS.activeKey
          : NOTE_COLORS.defaultBlackKey;
        ctx.fillRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
        ctx.strokeStyle = NOTE_COLORS.blackKeyBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
      }
    }

    // Draw MIDI status indicator
    ctx.fillStyle = midiEnabled ? '#4CAF50' : '#FF5722';
    ctx.font = '12px Arial';
    ctx.fillText(
      midiEnabled
        ? `MIDI: ${connectedDevices.length} device(s)`
        : 'MIDI: Disabled',
      10,
      20
    );

    // Continue animation loop
    animationFrameRef.current = requestAnimationFrame(draw);
  }, [getKeyInfo, createExplosion, midiEnabled, connectedDevices.length]);

  // Canvas setup effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const resizeObserver = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });

    resizeObserver.observe(canvas.parentElement);
    animationFrameRef.current = requestAnimationFrame(draw);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      resizeObserver.disconnect();
    };
  }, [draw]);

  // Handle remote MIDI messages
  useEffect(() => {
    if (!socket) return;

    const handleRemoteMidiMessage = ({
      userId,
      type,
      note,
      velocity,
      timestamp,
    }) => {
      console.log(
        `Remote MIDI from ${userId}: ${type} note ${note} velocity ${velocity}`
      );

      if (type === 'noteon') {
        const newNote = {
          note,
          startTime: performance.now(),
          velocity,
          isLocal: false,
          releaseTime: null,
          hasExploded: false,
          explodeTime: null,
          hasHitKey: false,
        };
        animatedNotesRef.current.push(newNote);
      } else if (type === 'noteoff') {
        animatedNotesRef.current.forEach((animNote) => {
          if (
            animNote.note === note &&
            !animNote.isLocal &&
            !animNote.releaseTime
          ) {
            animNote.releaseTime = performance.now();
          }
        });
      }
    };

    socket.on('remote-midi-message', handleRemoteMidiMessage);

    return () => {
      socket.off('remote-midi-message', handleRemoteMidiMessage);
    };
  }, [socket]);

  // WebMidi setup effect
  useEffect(() => {
    const setupMidi = async () => {
      try {
        const { WebMidi } = await import('webmidi');
        WebMidiInstance = WebMidi;

        await WebMidiInstance.enable();
        console.log('WebMidi enabled. Inputs:', WebMidiInstance.inputs);

        setMidiEnabled(true);
        setConnectedDevices(WebMidiInstance.inputs.map((input) => input.name));

        // Remove existing listeners
        WebMidiInstance.inputs.forEach((input) => {
          input.removeListener();
        });

        WebMidiInstance.inputs.forEach((input) => {
          input.addListener('noteon', 'all', (e) => {
            console.log(
              `Local Note On: ${e.note.number}, Velocity: ${e.note.attack}`
            );

            const newNote = {
              note: e.note.number,
              startTime: performance.now(),
              velocity: e.note.attack,
              isLocal: true,
              releaseTime: null,
              hasExploded: false,
              explodeTime: null,
              hasHitKey: false,
            };
            animatedNotesRef.current.push(newNote);

            if (socket && roomId) {
              socket.emit('midi-message', {
                roomId,
                type: 'noteon',
                note: e.note.number,
                velocity: e.note.attack,
                timestamp: performance.now(),
              });
            }
          });

          input.addListener('noteoff', 'all', (e) => {
            console.log(`Local Note Off: ${e.note.number}`);

            animatedNotesRef.current.forEach((note) => {
              if (
                note.note === e.note.number &&
                note.isLocal &&
                !note.releaseTime
              ) {
                note.releaseTime = performance.now();
              }
            });

            if (socket && roomId) {
              socket.emit('midi-message', {
                roomId,
                type: 'noteoff',
                note: e.note.number,
                velocity: e.note.release,
                timestamp: performance.now(),
              });
            }
          });
        });
      } catch (err) {
        console.error('WebMidi could not be enabled:', err);
        setMidiEnabled(false);
        setConnectedDevices([]);
      }
    };

    setupMidi();

    return () => {
      if (WebMidiInstance && WebMidiInstance.enabled) {
        WebMidiInstance.inputs.forEach((input) => {
          input.removeListener();
        });
        WebMidiInstance.disable();
        console.log('WebMidi disabled.');
        setMidiEnabled(false);
        setConnectedDevices([]);
      }
    };
  }, [socket, roomId]);

  return (
    <div className="flex flex-col w-full h-full items-center justify-center rounded-t-lg bg-gray-900">
      <div className="w-full flex-1">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      <div className="px-4 py-2 text-xs text-gray-400 bg-gray-800 rounded-b-lg w-full text-center">
        {midiEnabled
          ? `🎹 MIDI Ready • ${connectedDevices.length} device(s) connected`
          : '🎹 Connect a MIDI device to play music together'}
      </div>
    </div>
  );
};

export default MidiVisualizer;
