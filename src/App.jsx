import React, { useRef, useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  UserPlus,
  LogOut,
  Copy,
  Users,
  Music, // Import Music icon for MIDI toggle
} from 'lucide-react';
import MidiVisualizer from './MidiVisualizer'; // Import the new MidiVisualizer component

const App = () => {
  // State variables for managing application logic and UI
  const [socket, setSocket] = useState(null); // Socket.IO client instance
  const [roomId, setRoomId] = useState(''); // Current room ID
  const [joined, setJoined] = useState(false); // Flag to indicate if user has joined a room
  const localVideoRef = useRef(null); // Ref for the local user's video element
  const peersRef = useRef({}); // Stores RTCPeerConnection instances for each remote user
  const localStreamRef = useRef(null); // Holds the local MediaStream object
  const [remoteVideos, setRemoteVideos] = useState([]); // Array of remote video objects { id, stream, videoActive }
  const [error, setError] = useState(''); // Stores error messages
  const [localStream, setLocalStream] = useState(null); // Local MediaStream state
  const [isMuted, setIsMuted] = useState(false); // Local user's audio mute state
  const [isVideoEnabled, setIsVideoEnabled] = useState(true); // Local user's video enable state
  const [roomUrl, setRoomUrl] = useState(''); // URL for sharing the room
  const [isCopied, setIsCopied] = useState(false); // Flag for clipboard copy success message
  const [isCreator, setIsCreator] = useState(false); // Flag to indicate if the user created the room
  const [participantCount, setParticipantCount] = useState(1); // Number of participants in the room
  const [showMidiVisualizer, setShowMidiVisualizer] = useState(false); // NEW: State for MIDI visualizer visibility

  // Environment variables for backend URL and STUN/TURN servers
  // Make sure to set these in your .env file (e.g., VITE_BASE_URL=http://localhost:5000)
  const BASE_URL = import.meta.env.VITE_BASE_URL || 'http://localhost:5000';
  const STUN_TURN_SERVER =
    import.meta.env.VITE_STUN_TURN_SERVER || 'stun.l.google.com:19302';
  const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || '';
  const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD || '';

  /**
   * Fetches the local media stream (camera and microphone).
   * @returns {MediaStream|null} The media stream or null if an error occurs.
   */
  const getMediaStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log('Got media stream:', stream);
      localStreamRef.current = stream; // Store in ref for consistent access
      setLocalStream(stream); // Store in state to trigger re-renders

      // Initialize local video and audio states based on the obtained stream
      setIsVideoEnabled(
        stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled
      );
      setIsMuted(
        stream.getAudioTracks().length > 0 &&
          !stream.getAudioTracks()[0].enabled
      );

      return stream;
    } catch (err) {
      console.error('Error accessing media devices:', err);
      setError(`Error accessing camera or microphone: ${err.message}`);
      return null;
    }
  }, []);

  // Effect to set the local video element's srcObject when localStream changes
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Effect to initialize Socket.IO connection and handle basic connection errors
  useEffect(() => {
    const newSocket = io(BASE_URL);
    setSocket(newSocket);

    newSocket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
      setError(
        'Failed to connect to the server. Please check if the server is running.'
      );
    });

    newSocket.on('connect', () => {
      console.log('Connected to server with ID:', newSocket.id);
      setError(''); // Clear any previous connection errors
    });

    // Cleanup function: stop local media tracks and disconnect socket on component unmount
    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      newSocket.disconnect();
    };
  }, [BASE_URL]); // Re-run if BASE_URL changes

  // Effect to handle Socket.IO events once the socket is established
  useEffect(() => {
    if (!socket) return;

    /**
     * Handles the 'all-users' event, setting up RTCPeerConnections for existing users.
     * @param {string[]} users - Array of user IDs already in the room.
     */
    const handleAllUsers = (users) => {
      console.log('Received all users:', users);
      setParticipantCount(users.length + 1); // +1 for the local user
      users.forEach((userId) => {
        // Create a new peer connection for each existing user and send an offer
        const peer = createPeer(userId, socket.id, localStreamRef.current);
        peersRef.current[userId] = peer;
      });
    };

    /**
     * Handles the 'initial-video-states' event, updating remote video active states.
     * This is crucial for new users joining to know the initial video status of others.
     * @param {object} videoStates - Object mapping userId to their videoEnabled boolean.
     */
    const handleInitialVideoStates = (videoStates) => {
      console.log('Received initial video states:', videoStates);
      setRemoteVideos((prevRemoteVideos) => {
        const updatedVideos = prevRemoteVideos.map((video) => {
          // If a remote video already exists, update its videoActive status
          if (Object.prototype.hasOwnProperty.call(videoStates, video.id)) {
            return { ...video, videoActive: videoStates[video.id] };
          }
          return video;
        });

        // Add new entries for users whose streams haven't arrived yet but have video states
        const newUsersWithStates = Object.keys(videoStates).filter(
          (userId) => !prevRemoteVideos.some((v) => v.id === userId)
        );

        return [
          ...updatedVideos,
          ...newUsersWithStates.map((userId) => ({
            id: userId,
            stream: null, // Stream will be added later by ontrack event
            videoActive: videoStates[userId],
          })),
        ];
      });
    };

    /**
     * Handles the 'user-joined' event, adding a new peer for the joining user.
     * @param {string} userId - The ID of the user who just joined.
     */
    const handleUserJoined = (userId) => {
      console.log('User joined:', userId);
      if (userId === socket.id) return; // Don't process self
      setParticipantCount((prev) => prev + 1);
      // Add a new peer connection for the joining user and await their offer
      const peer = addPeer(userId, socket.id, localStreamRef.current);
      peersRef.current[userId] = peer;
    };

    /**
     * Handles the 'offer' event, setting remote description and sending an answer.
     * @param {object} payload - Contains sdp (Session Description Protocol) and caller ID.
     */
    const handleOffer = async ({ sdp, caller }) => {
      console.log('Received offer from:', caller);
      try {
        let peer = peersRef.current[caller];
        if (!peer) {
          // If peer doesn't exist, create it (this can happen if offer arrives before 'all-users' for some reason)
          peer = addPeer(caller, socket.id, localStreamRef.current);
          peersRef.current[caller] = peer;
        }
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('answer', { target: caller, sdp: peer.localDescription });
      } catch (error) {
        console.error('Error handling offer:', error);
      }
    };

    /**
     * Handles the 'answer' event, setting remote description for the peer.
     * @param {object} payload - Contains sdp (Session Description Protocol) and caller ID.
     */
    const handleAnswer = async ({ sdp, caller }) => {
      console.log('Received answer from:', caller);
      try {
        const peer = peersRef.current[caller];
        if (peer) {
          await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } catch (error) {
        console.error('Error handling answer:', error);
      }
    };

    /**
     * Handles the 'ice-candidate' event, adding the ICE candidate to the peer connection.
     * @param {object} payload - Contains candidate and the sender's ID.
     */
    const handleIceCandidate = async ({ from, candidate }) => {
      try {
        const peer = peersRef.current[from];
        if (peer && candidate) {
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    };

    /**
     * Handles the 'remoteVideoStateChange' event, updating a remote user's video status.
     * @param {object} payload - Contains userId and videoEnabled boolean.
     */
    const handleRemoteVideoStateChange = ({ userId, videoEnabled }) => {
      console.log(
        `Remote user ${userId} video state changed to: ${videoEnabled}`
      );
      setRemoteVideos((prev) =>
        prev.map((v) =>
          v.id === userId ? { ...v, videoActive: videoEnabled } : v
        )
      );
    };

    /**
     * Handles the 'user-disconnected' event, cleaning up peer connection and remote video.
     * @param {string} userId - The ID of the user who disconnected.
     */
    const handleUserDisconnected = (userId) => {
      console.log('User disconnected:', userId);
      if (peersRef.current[userId]) {
        peersRef.current[userId].close(); // Close the RTCPeerConnection
        delete peersRef.current[userId]; // Remove from peers reference
        setRemoteVideos((prev) => prev.filter((v) => v.id !== userId)); // Remove remote video from state
        setParticipantCount((prev) => Math.max(1, prev - 1)); // Decrement participant count
      }
    };

    /**
     * Handles the 'room-not-found' event, displaying an error and leaving the room.
     */
    const handleRoomNotFound = () => {
      setError(
        'This room does not exist. Please check the Room ID or create a new room.'
      );
      leaveRoom(); // Clean up local state
    };

    // Register all Socket.IO event listeners
    socket.on('all-users', handleAllUsers);
    socket.on('initial-video-states', handleInitialVideoStates);
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('remoteVideoStateChange', handleRemoteVideoStateChange);
    socket.on('user-disconnected', handleUserDisconnected);
    socket.on('room-not-found', handleRoomNotFound);
    socket.on('room-created', ({ roomId }) => {
      console.log('Room successfully created acknowledgment:', roomId);
      setIsCreator(true); // Set creator flag
    });
    socket.on('room-full', () => {
      setError('Room is full. Only two participants are allowed.');
    });

    // Cleanup function: unregister all Socket.IO event listeners on unmount or socket change
    return () => {
      socket.off('all-users', handleAllUsers);
      socket.off('initial-video-states', handleInitialVideoStates);
      socket.off('user-joined', handleUserJoined);
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('remoteVideoStateChange', handleRemoteVideoStateChange);
      socket.off('user-disconnected', handleUserDisconnected);
      socket.off('room-not-found');
      socket.off('room-created');
      socket.off('room-full');
    };
  }, [socket]); // Re-run this effect when the socket instance changes

  /**
   * Creates a new room and automatically joins it.
   */
  const createRoom = async () => {
    if (!socket) return;
    setError('');
    // Generate a random 6-digit room ID
    const newRoomId = Math.floor(100000 + Math.random() * 900000).toString();

    setRoomId(newRoomId);
    console.log('Requesting to create room with ID:', newRoomId);

    // Construct the full room URL for sharing
    const url = `${window.location.origin}?room=${newRoomId}`;
    setRoomUrl(url);

    // Emit 'create-room' event to the server
    socket.emit('create-room', { roomId: newRoomId });

    // Automatically join the newly created room
    await joinRoom(newRoomId);

    // Copy room URL to clipboard
    navigator.clipboard
      .writeText(url)
      .then(() => {
        console.log('Room URL copied to clipboard');
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 3000); // Show "Copied!" for 3 seconds
      })
      .catch((err) => console.error('Could not copy room URL:', err));
  };

  /**
   * Joins an existing room.
   * @param {string} [idToJoin=roomId] - The room ID to join. Defaults to the current roomId state.
   */
  const joinRoom = async (idToJoin = roomId) => {
    if (!idToJoin || !socket) {
      setError('Please enter a Room ID');
      return;
    }

    setError('');
    console.log('Attempting to join room:', idToJoin);

    // First, check if the room exists on the server
    socket.emit('check-room', { roomId: idToJoin });

    // Wait for the server's response on room existence
    const roomExistsPromise = new Promise((resolve) => {
      socket.once('room-exists', ({ exists }) => {
        resolve(exists);
      });
    });

    const roomExists = await roomExistsPromise;

    if (!roomExists) {
      setError(
        'This room does not exist. Please check the Room ID or create a new room.'
      );
      return;
    }

    // Get local media stream before joining
    const stream = await getMediaStream();
    if (!stream) {
      setError(
        'Failed to get camera/microphone access. Please ensure permissions are granted.'
      );
      return;
    }

    // Emit 'join-room' event to the server
    socket.emit('join-room', { roomId: idToJoin });
    setJoined(true); // Set joined state to true
    console.log('Successfully joined room:', idToJoin);
  };

  // Effect to read room ID from URL parameters on component mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  /**
   * Creates a new RTCPeerConnection and sets up event listeners for WebRTC signaling.
   * This function is used when initiating a connection (e.g., when a new user joins and sends an offer).
   * @param {string} userId - The ID of the remote user to connect with.
   * @param {string} callerId - The ID of the local user (the caller).
   * @param {MediaStream} stream - The local media stream to add to the peer connection.
   * @returns {RTCPeerConnection} The configured RTCPeerConnection instance.
   */
  const createPeer = (userId, callerId, stream) => {
    console.log('Creating peer for user:', userId);
    // Configure ICE servers, including STUN and optional TURN
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (TURN_USERNAME && TURN_PASSWORD && STUN_TURN_SERVER) {
      iceServers.push({
        urls: 'turn:' + STUN_TURN_SERVER,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      });
    }

    const peer = new RTCPeerConnection({ iceServers });

    // Add local media tracks to the peer connection
    if (stream) {
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    } else {
      console.warn(
        'No local stream available when creating peer for ' + userId
      );
    }

    // Event listener for ICE candidates (network information)
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          target: userId,
          candidate: event.candidate,
        });
      }
    };

    // Event listener for ICE connection state changes (for debugging)
    peer.oniceconnectionstatechange = () => {
      console.log(
        `ICE connection state with ${userId}: ${peer.iceConnectionState}`
      );
    };

    // Event listener for when remote tracks are received
    peer.ontrack = ({ streams }) => {
      console.log('Received tracks from:', userId);
      setRemoteVideos((prev) => {
        const exists = prev.find((v) => v.id === userId);
        if (exists) {
          // If remote video entry already exists, update its stream and preserve videoActive status
          return prev.map((v) =>
            v.id === userId
              ? {
                  ...v,
                  stream: streams[0],
                  videoActive:
                    v.videoActive !== undefined ? v.videoActive : true, // Preserve existing or default to true
                }
              : v
          );
        } else {
          // Add a new entry for the remote video, defaulting videoActive to true
          return [
            ...prev,
            { id: userId, stream: streams[0], videoActive: true },
          ];
        }
      });
    };

    // Create and send an WebRTC offer
    peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(() => {
        console.log('Sending offer to:', userId);
        socket.emit('offer', {
          target: userId,
          caller: callerId,
          sdp: peer.localDescription,
        });
      })
      .catch((err) => {
        console.error('Error creating offer:', err);
      });

    return peer;
  };

  /**
   * Adds a new RTCPeerConnection and sets up event listeners for WebRTC signaling.
   * This function is used when a remote user sends an offer to the local user.
   * It's similar to `createPeer` but doesn't immediately create an offer.
   * @param {string} userId - The ID of the remote user to connect with.
   * @param {string} callerId - The ID of the local user (the answerer).
   * @param {MediaStream} stream - The local media stream to add to the peer connection.
   * @returns {RTCPeerConnection} The configured RTCPeerConnection instance.
   */
  const addPeer = (userId, callerId, stream) => {
    console.log('Adding peer for user:', userId);

    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (TURN_USERNAME && TURN_PASSWORD && STUN_TURN_SERVER) {
      iceServers.push({
        urls: 'turn:' + STUN_TURN_SERVER,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      });
    }

    const peer = new RTCPeerConnection({ iceServers });

    if (stream) {
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    } else {
      console.warn('No local stream available when adding peer for ' + userId);
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          target: userId,
          candidate: event.candidate,
        });
      }
    };

    peer.oniceconnectionstatechange = () => {
      console.log(
        `ICE connection state with ${userId}: ${peer.iceConnectionState}`
      );
    };

    peer.ontrack = ({ streams }) => {
      console.log('Received remote stream from:', userId);
      setRemoteVideos((prev) => {
        const exists = prev.find((v) => v.id === userId);
        if (exists) {
          // If remote video entry already exists, update its stream and preserve videoActive status
          return prev.map((v) =>
            v.id === userId
              ? {
                  ...v,
                  stream: streams[0],
                  videoActive:
                    v.videoActive !== undefined ? v.videoActive : true,
                }
              : v
          );
        } else {
          // Add a new entry for the remote video, defaulting videoActive to true
          return [
            ...prev,
            { id: userId, stream: streams[0], videoActive: true },
          ];
        }
      });
    };

    return peer;
  };

  /**
   * Cleans up all resources when leaving a room.
   */
  const leaveRoom = () => {
    // Stop all local media tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }

    // Close all peer connections
    Object.values(peersRef.current).forEach((peer) => {
      if (peer) peer.close();
    });
    peersRef.current = {};
    // Reset all state variables
    setRemoteVideos([]);
    setJoined(false);
    setIsCreator(false);
    setRoomId('');
    setRoomUrl('');
    setError('');
    setParticipantCount(1); // Reset participant count
    setShowMidiVisualizer(false); // NEW: Reset MIDI visualizer state

    // Disconnect socket (this will also trigger server-side cleanup)
    if (socket) {
      socket.disconnect();
      setSocket(null); // Clear socket state
    }
    console.log('Left room.');
  };

  /**
   * Toggles the local user's microphone mute state.
   */
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled; // Toggle track's enabled state
      });
      setIsMuted(!isMuted); // Update local UI state
      // No socket emission for mute/unmute if you only want to update local UI.
      // If you want to show mute status for remote users, you'd emit a 'muteStateChange' event.
    }
  };

  /**
   * Toggles the local user's video enable state and emits the change to the server.
   */
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const newVideoState = !isVideoEnabled;
      videoTracks.forEach((track) => {
        track.enabled = newVideoState;
      });
      setIsVideoEnabled(newVideoState);

      // Replace video track in all peer connections
      Object.values(peersRef.current).forEach((peer) => {
        const sender = peer
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');
        if (sender && videoTracks[0]) {
          sender.replaceTrack(videoTracks[0]);
        }
      });

      if (socket && joined) {
        socket.emit('videoStateChange', { videoEnabled: newVideoState });
      }
    }
  };

  /**
   * Copies the room URL to the clipboard.
   */
  const copyRoomUrl = () => {
    navigator.clipboard.writeText(roomUrl).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 3000); // Show "Copied!" for 3 seconds
    });
  };

  // Determine local video position class dynamically
  // When MIDI is shown, it's on the right of the remote video area, which is now half the screen.
  // So, calc(50% + 1rem) pushes it beyond the left half to be within the right side of the left half.
  const localVideoPositionClass = showMidiVisualizer
    ? 'top-4 right-4 md:right-[calc(50%+1rem)]' // Adjusted to be on the right side of the left half (remote videos)
    : 'bottom-4 right-4'; // Bottom-right when MIDI visualizer is hidden

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-sans">
      {!joined ? (
        // Room entry screen
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-gray-800 shadow-2xl rounded-xl p-6">
            <div className="flex flex-col items-center gap-6">
              <h1 className="text-3xl font-bold text-indigo-300 mb-2">
                Video Chat Room
              </h1>
              <p className="text-gray-400 text-center max-w-md">
                Connect with others through secure, high-quality video calls.
                Create a room or join with a room ID.
              </p>

              {error && (
                <div className="bg-red-900 border border-red-700 text-red-300 px-4 py-3 rounded-lg relative w-full max-w-md">
                  {error}
                </div>
              )}

              <div className="flex flex-col items-center gap-4 w-full max-w-md">
                <button
                  onClick={createRoom}
                  className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-6 py-3 rounded-lg transition duration-300 w-full font-medium shadow-md flex items-center justify-center gap-2"
                >
                  <UserPlus size={20} /> Create Room
                </button>

                {roomUrl && (
                  <div className="w-full bg-gray-700 p-3 rounded-lg flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={roomUrl}
                      readOnly
                      className="bg-transparent flex-1 outline-none text-sm text-gray-200"
                    />
                    <button
                      onClick={copyRoomUrl}
                      className="text-indigo-400 hover:text-indigo-200 text-sm font-medium flex items-center gap-1"
                    >
                      <Copy size={16} /> {isCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 w-full">
                  <hr className="flex-1 border-gray-600" />
                  <span className="text-gray-500">or</span>
                  <hr className="flex-1 border-gray-600" />
                </div>

                <input
                  type="text"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  placeholder="Enter Room ID"
                  className="border border-gray-600 rounded-lg px-4 py-3 w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 transition bg-gray-700 text-white"
                />
                <button
                  onClick={() => joinRoom()}
                  disabled={!roomId}
                  className={`${
                    roomId
                      ? 'bg-indigo-600 hover:bg-indigo-700'
                      : 'bg-gray-500 cursor-not-allowed'
                  } text-white px-6 py-3 rounded-lg transition duration-300 w-full font-medium shadow-md`}
                >
                  Join Room
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        // Video chat room screen
        <div className="relative flex-1 flex flex-col md:flex-row p-4 bg-gray-900 overflow-hidden">
          {/* Main video area (remote videos) - Takes primary space or half-width */}
          <div
            className={`flex-1 relative flex flex-wrap items-center justify-center gap-4 rounded-lg overflow-hidden group bg-gray-800 p-2
                       ${
                         showMidiVisualizer
                           ? 'md:w-1/2 md:flex-shrink-0'
                           : 'md:w-full'
                       }`}
          >
            {/* Background blur effect (optional, can be removed if not desired) */}
            <div className="absolute inset-0 w-full h-full bg-gray-800 filter blur-lg scale-110"></div>

            {/* Render remote videos */}
            {remoteVideos.length > 0 ? (
              remoteVideos.map(({ id, stream, videoActive }) => (
                <div
                  key={id}
                  // These classes control the proportion for remote videos.
                  // For a consistent aspect ratio, 'aspect-video' (16:9) is generally good.
                  // The flex-grow/shrink with w-full/h-full help them fill available space.
                  // On small screens, they are responsive (w-full, h-full).
                  // On medium and larger screens, they adapt to the available space in the flex container.
                  className={`relative w-full h-full flex-grow flex-shrink z-10 aspect-video rounded-lg overflow-hidden
                              ${
                                showMidiVisualizer
                                  ? 'md:w-1/2 md:h-1/2 lg:w-1/3 lg:h-1/2 xl:w-1/4 xl:h-1/2'
                                  : 'sm:w-1/2 lg:w-1/3 xl:w-1/4 max-w-full max-h-full'
                              }`}
                >
                  <Video
                    stream={stream}
                    userId={id}
                    mirror={true} // Remote videos are typically mirrored for a natural feel
                    videoActive={videoActive}
                  />
                  <p className="absolute bottom-4 left-4 text-white text-base font-medium bg-black bg-opacity-50 px-3 py-1 rounded-md z-20">
                    {id.substring(0, 6)}...
                  </p>
                </div>
              ))
            ) : (
              <div className="relative flex items-center justify-center w-full h-full text-gray-500 text-2xl z-10">
                Waiting for others to join...
              </div>
            )}
          </div>

          {/* NEW: MIDI Visualizer - Conditionally rendered, takes half width on md and up */}
          {showMidiVisualizer && (
            <div
              className="mt-2 md:mt-0 md:ml-4 flex-shrink-0 bg-gray-800 bg-opacity-70 rounded-lg pt-2
                            h-1/3 md:h-auto md:w-1/2"
            >
              {' '}
              {/* Responsive height for mobile, half width for desktop */}
              <MidiVisualizer
                socket={socket}
                roomId={roomId}
                localUserId={socket?.id}
              />
            </div>
          )}

          {/* Local video preview - Positioned dynamically */}
          {localStream && (
            <div
              className={`absolute 
                           w-40 h-30
                           md:w-60 md:h-40
                           lg:w-72 lg:h-48
                           rounded-lg overflow-hidden z-20 m-4 shadow-xl border-2 border-indigo-500
                           ${localVideoPositionClass}`}
            >
              <video
                style={{ transform: 'scaleX(-1)' }} // Mirror local video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted // Local video should be muted to prevent echo
                className={`relative w-full h-full object-cover z-10 transition-opacity duration-300 ${
                  isVideoEnabled ? 'opacity-100' : 'opacity-0'
                }`}
              />

              {/* Overlay for "Camera Off" state */}
              {!isVideoEnabled && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-700 text-white z-20">
                  <div className="text-center">
                    <div className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-1">
                      <span className="text-xl font-bold">
                        {socket?.id?.substring(0, 1).toUpperCase() || 'Y'}
                      </span>
                    </div>
                    <p className="text-sm">Camera Off</p>
                  </div>
                </div>
              )}
              <p className="absolute bottom-1 left-1 text-white text-xs font-medium bg-gray-800 bg-opacity-50 px-2 py-0.5 rounded-md z-20">
                You
              </p>
            </div>
          )}
        </div>
      )}

      {/* Control bar at the bottom */}
      {joined && (
        <div className="mx-4 rounded-b-lg bg-gray-800 p-3 flex justify-center items-center z-30">
          <div className="flex-1 flex items-center justify-start gap-2 pl-3 text-gray-300">
            <p className="text-sm">
              Room ID :{' '}
              <span className="font-medium text-gray-300">{roomId}</span>
            </p>
          </div>

          <div className="flex items-center gap-4">
            {/* Mute/Unmute button */}
            <button
              onClick={toggleMute}
              className={`p-3 rounded-full transition-colors duration-200 ease-in-out ${
                isMuted
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            {/* Video On/Off button */}
            <button
              onClick={toggleVideo}
              className={`p-3 rounded-full transition-colors duration-200 ease-in-out ${
                !isVideoEnabled
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
              title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
            >
              {isVideoEnabled ? (
                <VideoIcon size={24} />
              ) : (
                <VideoOff size={24} />
              )}
            </button>
            {/* NEW: MIDI Visualizer Toggle Button */}
            <button
              onClick={() => setShowMidiVisualizer(!showMidiVisualizer)}
              className={`p-3 rounded-full transition-colors duration-200 ease-in-out ${
                showMidiVisualizer
                  ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
              title={
                showMidiVisualizer
                  ? 'Hide MIDI Visualizer'
                  : 'Show MIDI Visualizer'
              }
            >
              <Music size={24} />
            </button>
            {/* Leave room button */}
            <button
              onClick={leaveRoom}
              className="bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 rounded-full transition-colors duration-300 font-medium shadow-md flex items-center gap-1.5 text-sm"
            >
              <LogOut size={18} /> Leave
            </button>
          </div>

          {/* Participant count display */}
          <div className="flex-1 flex items-center justify-end gap-2 pr-3 text-gray-300">
            <Users size={24} />
            <span className="text-lg font-medium">{participantCount}</span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Video Component: Renders a video stream and an overlay when video is off.
 * @param {object} props - Component props.
 * @param {MediaStream} props.stream - The media stream to display.
 * @param {string} props.userId - The ID of the user associated with the stream.
 * @param {boolean} [props.mirror=false] - Whether to mirror the video horizontally.
 * @param {boolean} props.videoActive - Whether the video is currently active (true) or off (false).
 */
const Video = ({ stream, userId, mirror = false, videoActive }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current && !stream) {
      // If stream is null, clear srcObject to stop displaying previous stream
      videoRef.current.srcObject = null;
    }
    // The videoActive prop directly controls the display,
    // so no need to listen for 'mute'/'unmute' on the track itself for this component.
    // The parent (App) component now manages this state via signaling.
  }, [stream, userId, videoActive]); // Added videoActive to dependencies

  return (
    <div className="relative w-full h-full overflow-hidden rounded-lg shadow-lg bg-black group">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={mirror ? { transform: 'scaleX(-1)' } : {}}
        className={`relative w-full h-full object-contain z-10 transition-opacity duration-300 ${
          videoActive ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* Overlay for "Camera Off" state */}
      {!videoActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 text-white z-20">
          <div className="text-center">
            <div className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-1">
              <span className="text-lg font-bold">
                {userId?.substring(0, 1).toUpperCase() || 'U'}
              </span>
            </div>
            <p className="text-sm">Camera Off</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
