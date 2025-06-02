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

// Colors for different elements in the visualizer (Reverted to original, with gold for falling notes)
const NOTE_COLORS = {
  local: '#FFD700', // Gold for notes played by the local user
  remote: '#8A2BE2', // BlueViolet for notes played by remote users
  activeKey: '#4CAF50', // Green for keys currently pressed on the virtual keyboard
  defaultWhiteKey: '#F0F0F0', // Light gray for unpressed white keys
  defaultBlackKey: '#333333', // Dark gray for unpressed black keys
  // Note trail colors with transparency (using original gold and blueviolet)
  localTrail: 'rgba(255, 215, 0, 0.8)', // Gold with transparency
  remoteTrail: 'rgba(138, 43, 226, 0.8)', // BlueViolet with transparency
  keyBorder: '#666', // Key border
  blackKeyBorder: '#222', // Black key border
};

// Speed at which animated notes travel down the screen
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
  // Ref to track currently active (pressed) notes on the keyboard.
  const activeNotesRef = useRef({});
  // Ref to store animated notes currently falling down the screen
  const animatedNotesRef = useRef([]);
  // Ref to store explosion particles
  const explosionParticlesRef = useRef([]);
  // Animation frame ID for cleanup
  const animationFrameRef = useRef(null);

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
        vy: Math.sin(angle) * speed - 1, // Slight upward bias
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
    const dynamicBlackKeyHeight = dynamicKeyHeight * (2 / 3); // Black keys are typically 2/3 the height of white keys
    const BLACK_KEY_WIDTH_RATIO = 0.6; // Black keys are about 60% the width of white keys

    const startOctave = 3;
    const endOctave = 5;
    const numOctaves = endOctave - startOctave + 1;
    const totalWhiteKeys = numOctaves * WHITE_KEYS_RELATIVE.length;

    const dynamicWhiteKeyWidth =
      (canvas.width * KEYBOARD_WIDTH_PROPORTION) / totalWhiteKeys;
    const dynamicBlackKeyWidth = dynamicWhiteKeyWidth * BLACK_KEY_WIDTH_RATIO;

    const keyboardWidth = totalWhiteKeys * dynamicWhiteKeyWidth;
    const keyboardXOffset = (canvas.width - keyboardWidth) / 2;

    // Mapping of white key indices to draw black keys correctly in "gaps"
    // C# (1) is between C (0) and D (2) -> uses white key index 0
    // D# (3) is between D (2) and E (4) -> uses white key index 1
    // F# (6) is between F (5) and G (7) -> uses white key index 3
    // G# (8) is between G (7) and A (9) -> uses white key index 4
    // A# (10) is between A (9) and B (11) -> uses white key index 5
    const blackKeyWhiteKeyIndexMap = {
      1: 0, // C# relates to C
      3: 1, // D# relates to D
      6: 3, // F# relates to F
      8: 4, // G# relates to G
      10: 5, // A# relates to A
    };

    // First check if it's a black key
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
        const relativeNote = BLACK_KEYS_RELATIVE[i];
        if (relativeNote === -1) {
          continue; // Skip the E/F and B/C gaps for black keys
        }
        const blackKeyNote = octave * 12 + relativeNote;
        if (blackKeyNote === midiNote) {
          const baseWhiteKeyIndex =
            blackKeyWhiteKeyIndexMap[relativeNote] +
            (octave - startOctave) * WHITE_KEYS_RELATIVE.length;
          const baseWhiteKeyX =
            keyboardXOffset + baseWhiteKeyIndex * dynamicWhiteKeyWidth;

          // Position black key in the "gap" between white keys
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

    return null; // Note not in visible range
  }, []);

  // Callback function to draw on the canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Clear the entire canvas for each frame
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate dynamic key dimensions
    const dynamicKeyHeight = canvas.height * KEYBOARD_PROPORTION;
    const dynamicBlackKeyHeight = dynamicKeyHeight * (2 / 3); // Black keys are typically 2/3 the height of white keys
    const BLACK_KEY_WIDTH_RATIO = 0.6; // Black keys are about 60% the width of white keys

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

    // Mapping of white key indices to draw black keys correctly in "gaps"
    const blackKeyWhiteKeyIndexMapDraw = {
      1: 0, // C# relates to C
      3: 1, // D# relates to D
      6: 3, // F# relates to F
      8: 4, // G# relates to G
      10: 5, // A# relates to A
    };

    // --- Draw Animated Falling Notes First (so they appear behind the keyboard) ---
    const currentTime = performance.now();

    // Update and draw explosion particles
    explosionParticlesRef.current = explosionParticlesRef.current.filter(
      (particle) => {
        // Update particle position
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += 0.1; // Gravity
        particle.life -= particle.decay;

        if (particle.life <= 0) return false;

        // Draw particle
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

      // Calculate Y position: start from top and move down
      let yPos = (elapsedTime * NOTE_ANIMATION_SPEED) / 16.67; // Normalize to 60fps

      // Get key information for this note
      const keyInfo = getKeyInfo(note.note, canvas);
      if (!keyInfo) return false; // Remove note if out of visible range

      // Check if note has reached the keyboard and hasn't hit it yet
      if (yPos >= keyboardTopY && !note.hasHitKey) {
        // Mark key as active when the note hits the keyboard
        activeNotesRef.current = {
          ...activeNotesRef.current,
          [note.note]: { isLocal: note.isLocal, color: note.color },
        };

        // Create explosion effect at the center of the key
        createExplosion(
          keyInfo.centerX,
          keyboardTopY,
          note.isLocal ? NOTE_COLORS.local : NOTE_COLORS.remote, // Pass the correct color for explosion
          note.isLocal
        );
        note.hasExploded = true;
        note.explodeTime = currentTime;
        note.hasHitKey = true;
      }

      // If note has exploded, fade it out quickly
      let alpha = 1;
      if (note.hasExploded) {
        const explodeElapsed = currentTime - note.explodeTime;
        alpha = Math.max(0, 1 - explodeElapsed / EXPLOSION_DURATION); // Use EXPLOSION_DURATION
        if (alpha <= 0) {
          // If this was the last note for this key, deactivate it
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
          return false; // Remove exploded and faded note
        }
      }
      // If note is released but hasn't exploded, fade it out gradually
      else if (note.releaseTime && currentTime > note.releaseTime) {
        const fadeElapsed = currentTime - note.releaseTime;
        alpha = Math.max(0, 1 - fadeElapsed / NOTE_FADE_TIME);
        if (alpha <= 0) {
          // If this was the last note for this key, deactivate it
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
          return false; // Remove released and faded note
        }
      }

      // Don't draw the note if it has exploded and completely faded out
      if (note.hasExploded && alpha <= 0) return false;

      // Calculate note dimensions and position based on key type
      const currentNoteWidth = keyInfo.width * 0.8; // Make falling note slightly narrower than the key

      // Use centerX for both white and black keys to ensure perfect centering
      const currentNoteX = keyInfo.centerX - currentNoteWidth / 2;

      const noteHeight = Math.max(NOTE_MIN_LENGTH_PX, Math.min(80, yPos * 0.6));
      const borderRadius = 5;

      // Set color with alpha for fading effect
      ctx.globalAlpha = alpha;
      ctx.fillStyle = note.isLocal
        ? NOTE_COLORS.localTrail
        : NOTE_COLORS.remoteTrail;

      // Draw the falling note rectangle with rounded corners
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
        // Fallback for browsers not supporting roundRect
        ctx.fillRect(
          currentNoteX,
          yPos - noteHeight,
          currentNoteWidth,
          noteHeight
        );
      }
      ctx.fill();

      // Add a gradient effect for better visual appeal
      const gradient = ctx.createLinearGradient(
        currentNoteX,
        yPos - noteHeight,
        currentNoteX,
        yPos
      );
      gradient.addColorStop(
        0,
        note.isLocal
          ? `rgba(255, 215, 0, ${alpha * 0.3})` // Gold with transparency
          : `rgba(138, 43, 226, ${alpha * 0.3})` // BlueViolet with transparency
      );
      gradient.addColorStop(
        1,
        note.isLocal
          ? `rgba(255, 215, 0, ${alpha})` // Solid gold
          : `rgba(138, 43, 226, ${alpha})` // Solid blueviolet
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

      // Reset global alpha
      ctx.globalAlpha = 1;

      return true; // Keep the note if it's still active or fading
    });

    // --- Draw Keyboard Keys ---
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
        ctx.strokeStyle = NOTE_COLORS.keyBorder; // Key border
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, dynamicWhiteKeyWidth, dynamicKeyHeight);
        whiteKeyIndex++;
      }
    }

    // Draw black keys (overlaid on white keys)
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
        const relativeNote = BLACK_KEYS_RELATIVE[i];
        if (relativeNote === -1) {
          continue; // Skip the E/F and B/C gaps for black keys
        }

        const midiNote = octave * 12 + relativeNote;

        const baseWhiteKeyIndex =
          blackKeyWhiteKeyIndexMapDraw[relativeNote] +
          (octave - startOctave) * WHITE_KEYS_RELATIVE.length;
        const baseWhiteKeyX =
          keyboardXOffset + baseWhiteKeyIndex * dynamicWhiteKeyWidth;

        // Position black key in the "gap" between white keys
        const x =
          baseWhiteKeyX + dynamicWhiteKeyWidth - dynamicBlackKeyWidth / 2;
        const y = canvas.height - dynamicKeyHeight; // Black keys start at the same Y as white keys

        ctx.fillStyle = activeNotesRef.current[midiNote]
          ? NOTE_COLORS.activeKey
          : NOTE_COLORS.defaultBlackKey;
        ctx.fillRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
        ctx.strokeStyle = NOTE_COLORS.blackKeyBorder; // Black key border
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
      }
    }

    // Continue the animation loop
    animationFrameRef.current = requestAnimationFrame(draw);
  }, [getKeyInfo, createExplosion]);

  // Effect to set up canvas dimensions and start the drawing loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set canvas dimensions to fill its parent container
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    // Add a resize observer to update canvas dimensions when its parent resizes
    const resizeObserver = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });

    resizeObserver.observe(canvas.parentElement);

    // Start the animation loop
    animationFrameRef.current = requestAnimationFrame(draw);

    // Cleanup function
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      resizeObserver.disconnect();
    };
  }, [draw]);

  // Effect to handle remote MIDI messages received via Socket.IO
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
            !animNote.isLocal && // Ensure it's a remote note
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

  // Effect to set up WebMidi.js for local MIDI input
  useEffect(() => {
    const setupMidi = async () => {
      try {
        const { WebMidi } = await import('webmidi');
        WebMidiInstance = WebMidi;

        await WebMidiInstance.enable();
        console.log('WebMidi enabled. Inputs:', WebMidiInstance.inputs);

        // Remove all existing listeners before adding new ones to prevent duplicates
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
                note.isLocal && // Ensure it's a local note
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
      }
    };

    setupMidi();

    return () => {
      if (WebMidiInstance && WebMidiInstance.enabled) {
        WebMidiInstance.inputs.forEach((input) => {
          input.removeListener(); // Remove all listeners from each input
        });
        WebMidiInstance.disable();
        console.log('WebMidi disabled.');
      }
    };
  }, [socket, roomId]);

  return (
    <div className="flex w-full h-full items-center justify-center rounded-t-lg">
      <canvas ref={canvasRef} className="w-full h-full"></canvas>
    </div>
  );
};

export default MidiVisualizer;
