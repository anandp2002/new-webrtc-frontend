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
  AlertCircle,
} from 'lucide-react';

const App = () => {
  // State variables
  const [socket, setSocket] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const localVideoRef = useRef(null);
  const peersRef = useRef({});
  const localStreamRef = useRef(null);
  const [remoteVideos, setRemoteVideos] = useState([]);
  const [error, setError] = useState('');
  const [localStream, setLocalStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [roomUrl, setRoomUrl] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
  const [participantCount, setParticipantCount] = useState(1);

  // Environment variables
  const BASE_URL = import.meta.env.VITE_BASE_URL || 'http://localhost:5000';
  const STUN_TURN_SERVER =
    import.meta.env.VITE_STUN_TURN_SERVER || 'stun.l.google.com:19302';
  const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || '';
  const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD || '';

  // Function to initialize socket connection
  const initializeSocket = useCallback(() => {
    if (socket) {
      socket.disconnect();
    }

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
      setError('');
    });

    return newSocket;
  }, [BASE_URL]);

  const getMediaStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log('Got media stream:', stream);
      localStreamRef.current = stream;
      setLocalStream(stream);

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

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Initialize socket on component mount
  useEffect(() => {
    initializeSocket();

    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [initializeSocket]);

  useEffect(() => {
    if (!socket) return;

    const handleAllUsers = (users) => {
      console.log('Received all users:', users);
      setParticipantCount(users.length + 1);
      users.forEach((userId) => {
        const peer = createPeer(userId, socket.id, localStreamRef.current);
        peersRef.current[userId] = peer;
      });
    };

    const handleInitialVideoStates = (videoStates) => {
      console.log('Received initial video states:', videoStates);
      setRemoteVideos((prevRemoteVideos) => {
        const updatedVideos = prevRemoteVideos.map((video) => {
          if (Object.prototype.hasOwnProperty.call(videoStates, video.id)) {
            return { ...video, videoActive: videoStates[video.id] };
          }
          return video;
        });

        const newUsersWithStates = Object.keys(videoStates).filter(
          (userId) => !prevRemoteVideos.some((v) => v.id === userId)
        );

        return [
          ...updatedVideos,
          ...newUsersWithStates.map((userId) => ({
            id: userId,
            stream: null,
            videoActive: videoStates[userId],
            audioActive: true,
          })),
        ];
      });
    };

    const handleInitialAudioStates = (audioStates) => {
      console.log('Received initial audio states:', audioStates);
      setRemoteVideos((prevRemoteVideos) => {
        return prevRemoteVideos.map((video) => {
          if (Object.prototype.hasOwnProperty.call(audioStates, video.id)) {
            return { ...video, audioActive: audioStates[video.id] };
          }
          return video;
        });
      });
    };

    const handleUserJoined = (userId) => {
      console.log('User joined:', userId);
      if (userId === socket.id) return;
      setParticipantCount((prev) => prev + 1);
      const peer = addPeer(userId, socket.id, localStreamRef.current);
      peersRef.current[userId] = peer;
    };

    const handleOffer = async ({ sdp, caller }) => {
      console.log('Received offer from:', caller);
      try {
        let peer = peersRef.current[caller];
        if (!peer) {
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

    const handleRemoteAudioStateChange = ({ userId, audioEnabled }) => {
      console.log(
        `Remote user ${userId} audio state changed to: ${audioEnabled}`
      );
      setRemoteVideos((prev) =>
        prev.map((v) =>
          v.id === userId ? { ...v, audioActive: audioEnabled } : v
        )
      );
    };

    const handleUserDisconnected = (userId) => {
      console.log('User disconnected:', userId);
      if (peersRef.current[userId]) {
        peersRef.current[userId].close();
        delete peersRef.current[userId];
        setRemoteVideos((prev) => prev.filter((v) => v.id !== userId));
        setParticipantCount((prev) => Math.max(1, prev - 1));
      }
    };

    const handleRoomNotFound = () => {
      setError(
        'This room does not exist. Please check the Room ID or create a new room.'
      );
    };

    const handleRoomFull = ({
      message,
      currentParticipants,
      maxParticipants,
    }) => {
      console.log('Room is full:', message);
      setError(
        `Room is full! Currently ${currentParticipants}/${maxParticipants} participants. Please try joining a different room or create a new one.`
      );
    };

    // Register event listeners
    socket.on('all-users', handleAllUsers);
    socket.on('initial-video-states', handleInitialVideoStates);
    socket.on('initial-audio-states', handleInitialAudioStates);
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('remoteVideoStateChange', handleRemoteVideoStateChange);
    socket.on('remoteAudioStateChange', handleRemoteAudioStateChange);
    socket.on('user-disconnected', handleUserDisconnected);
    socket.on('room-not-found', handleRoomNotFound);
    socket.on('room-full', handleRoomFull);
    socket.on('room-created', ({ roomId }) => {
      console.log('Room successfully created acknowledgment:', roomId);
      setIsCreator(true);
    });

    return () => {
      socket.off('all-users', handleAllUsers);
      socket.off('initial-video-states', handleInitialVideoStates);
      socket.off('initial-audio-states', handleInitialAudioStates);
      socket.off('user-joined', handleUserJoined);
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('remoteVideoStateChange', handleRemoteVideoStateChange);
      socket.off('remoteAudioStateChange', handleRemoteAudioStateChange);
      socket.off('user-disconnected', handleUserDisconnected);
      socket.off('room-not-found');
      socket.off('room-full');
      socket.off('room-created');
    };
  }, [socket]);

  const createRoom = async () => {
    // Ensure we have a fresh socket connection
    if (!socket || !socket.connected) {
      const newSocket = initializeSocket();
      // Wait for connection before proceeding
      await new Promise((resolve) => {
        newSocket.on('connect', resolve);
      });
    }

    setError('');
    const newRoomId = Math.floor(100000 + Math.random() * 900000).toString();

    setRoomId(newRoomId);
    console.log('Requesting to create room with ID:', newRoomId);

    const url = `${window.location.origin}?room=${newRoomId}`;
    setRoomUrl(url);

    socket.emit('create-room', { roomId: newRoomId });
    await joinRoom(newRoomId);

    navigator.clipboard
      .writeText(url)
      .then(() => {
        console.log('Room URL copied to clipboard');
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 3000);
      })
      .catch((err) => console.error('Could not copy room URL:', err));
  };

  const joinRoom = async (idToJoin = roomId) => {
    if (!idToJoin) {
      setError('Please enter a Room ID');
      return;
    }

    // Ensure we have a fresh socket connection
    if (!socket || !socket.connected) {
      const newSocket = initializeSocket();
      // Wait for connection before proceeding
      await new Promise((resolve) => {
        newSocket.on('connect', resolve);
      });
    }

    setError('');
    console.log('Attempting to join room:', idToJoin);

    socket.emit('check-room', { roomId: idToJoin });

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

    const stream = await getMediaStream();
    if (!stream) {
      setError(
        'Failed to get camera/microphone access. Please ensure permissions are granted.'
      );
      return;
    }

    socket.emit('join-room', { roomId: idToJoin });
    setJoined(true);
    console.log('Successfully joined room:', idToJoin);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  const createPeer = (userId, callerId, stream) => {
    console.log('Creating peer for user:', userId);
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
      console.warn(
        'No local stream available when creating peer for ' + userId
      );
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
      console.log('Received tracks from:', userId);
      setRemoteVideos((prev) => {
        const exists = prev.find((v) => v.id === userId);
        if (exists) {
          return prev.map((v) =>
            v.id === userId
              ? {
                  ...v,
                  stream: streams[0],
                  videoActive:
                    v.videoActive !== undefined ? v.videoActive : true,
                  audioActive:
                    v.audioActive !== undefined ? v.audioActive : true,
                }
              : v
          );
        } else {
          return [
            ...prev,
            {
              id: userId,
              stream: streams[0],
              videoActive: true,
              audioActive: true,
            },
          ];
        }
      });
    };

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
          return prev.map((v) =>
            v.id === userId
              ? {
                  ...v,
                  stream: streams[0],
                  videoActive:
                    v.videoActive !== undefined ? v.videoActive : true,
                  audioActive:
                    v.audioActive !== undefined ? v.audioActive : true,
                }
              : v
          );
        } else {
          return [
            ...prev,
            {
              id: userId,
              stream: streams[0],
              videoActive: true,
              audioActive: true,
            },
          ];
        }
      });
    };

    return peer;
  };

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
    setParticipantCount(1);

    // Don't disconnect socket, just leave the room on the server side
    if (socket && socket.connected) {
      socket.disconnect();
    }

    // Initialize a fresh socket connection for future use
    setTimeout(() => {
      initializeSocket();
    }, 100);

    console.log('Left room and reset for new connection.');
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      const newMuteState = !isMuted;
      audioTracks.forEach((track) => {
        track.enabled = !newMuteState;
      });
      setIsMuted(newMuteState);

      if (socket && joined) {
        socket.emit('audioStateChange', { audioEnabled: !newMuteState });
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const newVideoState = !isVideoEnabled;
      videoTracks.forEach((track) => {
        track.enabled = newVideoState;
      });
      setIsVideoEnabled(newVideoState);

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

  const copyRoomUrl = () => {
    navigator.clipboard.writeText(roomUrl).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 3000);
    });
  };

  const clearError = () => {
    setError('');
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-sans">
      {!joined ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-gray-800 shadow-2xl rounded-xl p-6">
            <div className="flex flex-col items-center gap-6">
              <h1 className="text-3xl font-bold text-indigo-300 mb-2">
                Video Chat Room
              </h1>
              <p className="text-gray-400 text-center max-w-md">
                Connect with others through secure, high-quality video calls.
                Create a room or join with a room ID. (Max 2 participants per
                room)
              </p>

              {error && (
                <div className="bg-red-900 border border-red-700 text-red-300 px-4 py-3 rounded-lg relative w-full max-w-md">
                  <div className="flex items-start gap-3">
                    <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium mb-1">Unable to join room</p>
                      <p className="text-sm">{error}</p>
                    </div>
                    <button
                      onClick={clearError}
                      className="text-red-300 hover:text-red-100 ml-2"
                      aria-label="Close error"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col items-center gap-4 w-full max-w-md">
                <button
                  onClick={createRoom}
                  className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-6 py-3 rounded-lg transition duration-300 w-full font-medium shadow-md flex items-center justify-center gap-2"
                >
                  <UserPlus size={20} /> Create New Room
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
        <div className="relative flex-1 flex flex-col p-4 bg-gray-900 overflow-hidden">
          {/* Main video area - full width */}
          <div className="flex-1 relative flex flex-wrap items-center justify-center gap-4 rounded-lg overflow-hidden group bg-gray-800 p-2">
            <div className="absolute inset-0 w-full h-full bg-gray-800 filter blur-lg scale-110"></div>

            {remoteVideos.length > 0 ? (
              remoteVideos.map(({ id, stream, videoActive, audioActive }) => (
                <div
                  key={id}
                  className="relative w-full h-full flex-grow flex-shrink z-10 aspect-video rounded-lg overflow-hidden sm:w-1/2 lg:w-1/3 xl:w-1/4 max-w-full max-h-full"
                >
                  <Video
                    stream={stream}
                    userId={id}
                    mirror={true}
                    videoActive={videoActive}
                    audioActive={audioActive}
                  />
                  <p className="absolute bottom-4 left-4 text-white text-base font-medium bg-black bg-opacity-50 px-3 py-1 rounded-md z-20">
                    {id.substring(0, 6)}...
                  </p>
                </div>
              ))
            ) : (
              <div className="relative flex items-center justify-center w-full h-full text-gray-500 text-2xl z-10">
                <div className="text-center">
                  <Users size={48} className="mx-auto mb-4 opacity-50" />
                  <p>Waiting for others to join...</p>
                  <p className="text-lg mt-2">
                    Room capacity: {participantCount}/2
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Local video preview - always positioned at bottom-right */}
          {localStream && (
            <div className="absolute bottom-4 right-4 w-40 h-30 md:w-60 md:h-40 lg:w-72 lg:h-48 rounded-lg overflow-hidden z-20 m-4 shadow-xl border-2 border-indigo-500">
              <video
                style={{ transform: 'scaleX(-1)' }}
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`relative w-full h-full object-cover z-10 transition-opacity duration-300 ${
                  isVideoEnabled ? 'opacity-100' : 'opacity-0'
                }`}
              />

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
              {isMuted && (
                <div className="absolute top-1 left-1">
                  <div className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center">
                    <MicOff size={12} className="text-white" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {joined && (
        <div className="mx-4 rounded-b-lg bg-gray-800 p-3 flex justify-center items-center z-30">
          <div className="flex-1 flex items-center justify-start gap-2 pl-3 text-gray-300">
            <p className="text-sm">
              Room ID:{' '}
              <span className="font-medium text-gray-300">{roomId}</span>
            </p>
          </div>

          <div className="flex items-center gap-4">
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

            <button
              onClick={leaveRoom}
              className="bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 rounded-full transition-colors duration-300 font-medium shadow-md flex items-center gap-1.5 text-sm"
            >
              <LogOut size={18} /> Leave
            </button>
          </div>

          <div className="flex-1 flex items-center justify-end gap-2 pr-3 text-gray-300">
            <Users size={24} />
            <span className="text-lg font-medium">{participantCount}/2</span>
          </div>
        </div>
      )}
    </div>
  );
};

const Video = ({
  stream,
  userId,
  mirror = false,
  videoActive,
  audioActive,
}) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current && !stream) {
      videoRef.current.srcObject = null;
    }
  }, [stream, userId, videoActive]);

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
      {/* Single mute indicator in top-right corner only */}
      {!audioActive && videoActive && (
        <div className="absolute top-2 right-2">
          <div className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center">
            <MicOff size={12} className="text-white" />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
