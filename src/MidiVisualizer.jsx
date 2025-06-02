import React, { useRef, useEffect, useState, useCallback } from 'react';
// Dynamically import WebMidi to avoid issues if it's not supported or enabled
let WebMidiInstance = null; // Renamed to clearly indicate it holds the imported instance

// Constants for drawing the virtual keyboard and animated notes
// KEY_WIDTH and BLACK_KEY_WIDTH will now be calculated dynamically based on canvas width
// KEY_HEIGHT and BLACK_KEY_HEIGHT will now be calculated dynamically based on canvas height

// Proportion of the canvas height that the keyboard should occupy
const KEYBOARD_PROPORTION = 0.9; // Keyboard will occupy 90% of the canvas height
// Proportion of the canvas width that the keyboard should occupy
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
};

// Speed at which animated notes travel up the screen
const NOTE_ANIMATION_SPEED = 0.05; // Relative speed (e.g., 0.05 means 5% of height per second)

/**
 * MidiVisualizer Component: Displays a real-time virtual piano keyboard and animated notes.
 * It listens for local MIDI input and remote MIDI messages via Socket.IO.
 *
 * @param {object} props - Component props.
 * @param {SocketIOClient.Socket} props.socket - The Socket.IO client instance.
 * @param {string} props.roomId - The ID of the current video chat room.
 * @param {string} props.localUserId - The ID of the local user.
 */
const MidiVisualizer = ({ socket, roomId, localUserId }) => {
  const canvasRef = useRef(null); // Ref for the canvas element
  // State to track currently active (pressed) notes on the keyboard
  // Structure: { midiNoteNumber: { isLocal: boolean, color: string }, ... }
  const [activeNotes, setActiveNotes] = useState({});
  // Ref to store animated notes currently moving up the screen
  // Structure: [{ note: midiNoteNumber, startTime: performance.now(), color: string, velocity: number }]
  const animatedNotesRef = useRef([]);

  // Callback function to draw on the canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Clear the entire canvas for each frame
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate dynamic key dimensions based on canvas height and width
    const dynamicKeyHeight = canvas.height * KEYBOARD_PROPORTION;
    const dynamicBlackKeyHeight = dynamicKeyHeight * (50 / 80); // Maintain original black key height ratio (50/80 from original constants)

    // Define the range of octaves to display on the keyboard
    const startOctave = 3; // Start drawing from C3 (MIDI note 48)
    const endOctave = 5; // End drawing at B5 (MIDI note 83)
    const numOctaves = endOctave - startOctave + 1;
    const totalWhiteKeys = numOctaves * WHITE_KEYS_RELATIVE.length;

    // Calculate dynamic key width based on canvas width and number of keys
    const dynamicKeyWidth =
      (canvas.width * KEYBOARD_WIDTH_PROPORTION) / totalWhiteKeys;
    const dynamicBlackKeyWidth = dynamicKeyWidth * (12 / 20); // Maintain original black key width ratio

    // Calculate the total width of the keyboard based on the new dynamic key width
    const keyboardWidth = totalWhiteKeys * dynamicKeyWidth;
    // Center the keyboard horizontally on the canvas
    const keyboardXOffset = (canvas.width - keyboardWidth) / 2;

    // --- Draw Keyboard Keys ---
    // Draw white keys first
    let whiteKeyIndex = 0; // Tracks the sequential index of white keys for positioning
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < WHITE_KEYS_RELATIVE.length; i++) {
        const midiNote = octave * 12 + WHITE_KEYS_RELATIVE[i];
        const x = keyboardXOffset + whiteKeyIndex * dynamicKeyWidth;
        const y = canvas.height - dynamicKeyHeight; // Position at the bottom of the canvas, using dynamic height

        // Set fill color based on whether the key is currently active
        ctx.fillStyle = activeNotes[midiNote]
          ? NOTE_COLORS.activeKey
          : NOTE_COLORS.defaultWhiteKey;
        ctx.fillRect(x, y, dynamicKeyWidth, dynamicKeyHeight); // Draw the key rectangle
        ctx.strokeStyle = '#666'; // Border color
        ctx.strokeRect(x, y, dynamicKeyWidth, dynamicKeyHeight); // Draw the border
        whiteKeyIndex++;
      }
    }

    // Draw black keys (overlaid on white keys)
    whiteKeyIndex = 0; // Reset index for black key positioning logic
    for (let octave = startOctave; octave <= endOctave; octave++) {
      for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
        const relativeNote = BLACK_KEYS_RELATIVE[i];
        if (relativeNote === -1) {
          // Skip the E/F gap (no black key between E and F)
          whiteKeyIndex++; // Advance white key index to correctly position next black key
          continue;
        }

        const midiNote = octave * 12 + relativeNote;
        // Calculate X position for black keys: offset from white key, shifted by half black key width
        const x =
          keyboardXOffset +
          whiteKeyIndex * dynamicKeyWidth +
          (dynamicKeyWidth - dynamicBlackKeyWidth / 2);
        const y = canvas.height - dynamicKeyHeight; // Position at the bottom of the canvas

        ctx.fillStyle = activeNotes[midiNote]
          ? NOTE_COLORS.activeKey
          : NOTE_COLORS.defaultBlackKey;
        ctx.fillRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
        ctx.strokeStyle = '#222';
        ctx.strokeRect(x, y, dynamicBlackKeyWidth, dynamicBlackKeyHeight);
        whiteKeyIndex++;
      }
      whiteKeyIndex++; // Account for the C-D, D-E, F-G, G-A, A-B black keys
    }

    // --- Draw Animated Notes ---
    // Filter out notes that have moved off-screen and update positions of remaining notes
    animatedNotesRef.current = animatedNotesRef.current.filter((note) => {
      const elapsedTime = (performance.now() - note.startTime) / 1000; // Time in seconds since note started
      // Calculate Y position: start from top of keyboard and move upwards
      const yPos =
        canvas.height -
        dynamicKeyHeight - // Notes start from the top of the dynamically sized keyboard
        elapsedTime * (canvas.height - dynamicKeyHeight) * NOTE_ANIMATION_SPEED;

      // Determine X position of the animated note based on its MIDI pitch
      let keyX = 0;
      let isWhiteKey = false;
      let currentWhiteKeyIndex = 0;
      for (let octave = startOctave; octave <= endOctave; octave++) {
        for (let i = 0; i < WHITE_KEYS_RELATIVE.length; i++) {
          const midiNoteForWhiteKey = octave * 12 + WHITE_KEYS_RELATIVE[i];
          if (midiNoteForWhiteKey === note.note) {
            keyX = keyboardXOffset + currentWhiteKeyIndex * dynamicKeyWidth;
            isWhiteKey = true;
            break;
          }
          currentWhiteKeyIndex++;
        }
        if (isWhiteKey) break; // Found the white key
      }

      if (!isWhiteKey) {
        // If it's not a white key, it must be a black key
        currentWhiteKeyIndex = 0; // Reset for black key positioning
        for (let octave = startOctave; octave <= endOctave; octave++) {
          for (let i = 0; i < BLACK_KEYS_RELATIVE.length; i++) {
            const relativeNote = BLACK_KEYS_RELATIVE[i];
            if (relativeNote === -1) {
              currentWhiteKeyIndex++;
              continue;
            }
            const midiNoteForBlackKey = octave * 12 + relativeNote;
            if (midiNoteForBlackKey === note.note) {
              keyX =
                keyboardXOffset +
                currentWhiteKeyIndex * dynamicKeyWidth +
                (dynamicKeyWidth - dynamicBlackKeyWidth / 2);
              break;
            }
            currentWhiteKeyIndex++;
          }
          if (keyX !== 0) break; // Found the black key
          currentWhiteKeyIndex++;
        }
      }

      // Calculate note size based on velocity (stronger hits = larger notes)
      const noteSize = 10 + (note.velocity / 127) * 10;
      // Center the animated note above its corresponding key
      const noteX =
        keyX + (isWhiteKey ? dynamicKeyWidth / 2 : dynamicBlackKeyWidth / 2);

      ctx.fillStyle = note.color; // Set color (local/remote)
      ctx.beginPath();
      ctx.arc(noteX, yPos, noteSize / 2, 0, Math.PI * 2); // Draw a circle
      ctx.fill();

      return yPos > 0; // Return true to keep the note if it's still on screen
    });

    // Request the next animation frame to continue the drawing loop
    requestAnimationFrame(draw);
  }, [activeNotes]); // Redraw when activeNotes change (keys pressed/released)

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
      // Redraw immediately after resize to prevent visual glitches
      draw();
    });

    resizeObserver.observe(canvas.parentElement);

    // Start the animation loop
    const animationFrameId = requestAnimationFrame(draw);

    // Cleanup function: cancel the animation frame and disconnect resize observer when component unmounts
    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, [draw]); // Re-run if the draw function itself changes

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
      setActiveNotes((prev) => {
        const newState = { ...prev };
        if (type === 'noteon') {
          // Add the note to activeNotes and to the animatedNotes queue
          newState[note] = { isLocal: false, color: NOTE_COLORS.remote };
          animatedNotesRef.current.push({
            note,
            startTime: performance.now(), // Use current time for animation start
            color: NOTE_COLORS.remote,
            velocity,
          });
        } else if (type === 'noteoff') {
          // Remove the note from activeNotes
          delete newState[note];
        }
        return newState;
      });
    };

    // Register the listener for remote MIDI messages
    socket.on('remote-midi-message', handleRemoteMidiMessage);

    // Cleanup function: remove the listener when component unmounts or socket changes
    return () => {
      socket.off('remote-midi-message', handleRemoteMidiMessage);
    };
  }, [socket]); // Re-run if the socket instance changes

  // Effect to set up WebMidi.js for local MIDI input
  useEffect(() => {
    const setupMidi = async () => {
      try {
        // --- FIX IS HERE: Correctly destructure WebMidi from the imported module ---
        const { WebMidi } = await import('webmidi');
        WebMidiInstance = WebMidi; // Assign the actual WebMidi object to the instance variable

        await WebMidiInstance.enable(); // Now, .enable() should be a function
        console.log('WebMidi enabled. Inputs:', WebMidiInstance.inputs);

        // Add listeners for 'noteon' and 'noteoff' events for all connected MIDI inputs
        WebMidiInstance.inputs.forEach((input) => {
          // Use WebMidiInstance
          input.addListener('noteon', 'all', (e) => {
            console.log(
              `Local Note On: ${e.note.number}, Velocity: ${e.note.attack}`
            );
            setActiveNotes((prev) => ({
              ...prev,
              [e.note.number]: { isLocal: true, color: NOTE_COLORS.local },
            }));
            animatedNotesRef.current.push({
              note: e.note.number,
              startTime: performance.now(),
              color: NOTE_COLORS.local,
              velocity: e.note.attack,
            });
            // Emit local MIDI message to the server for broadcasting to remote users
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
            setActiveNotes((prev) => {
              const newState = { ...prev };
              delete newState[e.note.number];
              return newState;
            });
            // Emit local MIDI message to the server for broadcasting to remote users
            if (socket && roomId) {
              socket.emit('midi-message', {
                roomId,
                type: 'noteoff',
                note: e.note.number,
                velocity: e.note.release, // Use release velocity for note off
                timestamp: performance.now(),
              });
            }
          });
        });
      } catch (err) {
        console.error(
          'WebMidi could not be enabled. Make sure a MIDI device is connected and permissions are granted.',
          err
        );
        // Optionally, display a user-friendly message if MIDI is not available
      }
    };

    setupMidi();

    // Cleanup function: disable WebMidi and remove listeners on component unmount
    return () => {
      if (WebMidiInstance && WebMidiInstance.enabled) {
        // Use WebMidiInstance
        WebMidiInstance.inputs.forEach((input) => {
          input.removeListener(); // Remove all listeners from MIDI inputs
        });
        WebMidiInstance.disable(); // Disable WebMidi access
        console.log('WebMidi disabled.');
      }
    };
  }, [socket, roomId, localUserId]); // Dependencies: re-setup if socket, room, or user ID changes

  return (
    // This div no longer uses absolute positioning. Its height is controlled by the parent.
    // The background opacity is now handled by the parent container in App.js.
    <div className="flex w-full h-full items-center justify-center rounded-t-lg">
      <canvas ref={canvasRef} className="w-full sm:w-4/6 h-full"></canvas>
    </div>
  );
};

export default MidiVisualizer;
