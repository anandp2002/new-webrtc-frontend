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
} from 'lucide-react';

const App = () => {
  const [socket, setSocket] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const localVideoRef = useRef(null);
  const localBackgroundVideoRef = useRef(null); // Keeping declaration as it was present
  const peersRef = useRef({});
  const localStreamRef = useRef(null); // This will hold the actual MediaStream object
  // remoteVideos now includes a 'videoActive' property
  const [remoteVideos, setRemoteVideos] = useState([]);
  const [error, setError] = useState('');
  const [localStream, setLocalStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true); // Tracks local user's video state
  const [roomUrl, setRoomUrl] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
  const [participantCount, setParticipantCount] = useState(1);

  const BASE_URL = import.meta.env.VITE_BASE_URL || 'http://localhost:5000';
  const STUN_TURN_SERVER =
    import.meta.env.VITE_STUN_TURN_SERVER || 'stun.l.google.com:19302';
  const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || '';
  const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD || '';

  const getMediaStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log('Got media stream:', stream);
      localStreamRef.current = stream;
      setLocalStream(stream);
      // Initialize local video state based on stream tracks
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
      setError('');
    });

    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      newSocket.disconnect();
    };
  }, [BASE_URL]);

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

    // NEW: Handle initial video states when joining a room
    const handleInitialVideoStates = (videoStates) => {
      console.log('Received initial video states:', videoStates);
      setRemoteVideos((prevRemoteVideos) => {
        return prevRemoteVideos
          .map((video) => {
            // If a remote video already exists, update its videoActive status
            if (Object.prototype.hasOwnProperty.call(videoStates, video.id)) {
              return { ...video, videoActive: videoStates[video.id] };
            }

            return video;
          })
          .concat(
            Object.keys(videoStates) // Add new entries for users whose streams haven't arrived yet
              .filter(
                (userId) => !prevRemoteVideos.some((v) => v.id === userId)
              )
              .map((userId) => ({
                id: userId,
                stream: null, // Stream will be added later by ontrack
                videoActive: videoStates[userId],
              }))
          );
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

    // NEW: Handle remote video state changes
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
      leaveRoom();
    };

    socket.on('all-users', handleAllUsers);
    socket.on('initial-video-states', handleInitialVideoStates); // NEW
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('remoteVideoStateChange', handleRemoteVideoStateChange); // NEW
    socket.on('user-disconnected', handleUserDisconnected);
    socket.on('room-not-found', handleRoomNotFound);
    socket.on('room-created', ({ roomId }) => {
      console.log('Room successfully created acknowledgment:', roomId);
      setIsCreator(true);
    });

    return () => {
      socket.off('all-users', handleAllUsers);
      socket.off('initial-video-states', handleInitialVideoStates); // NEW
      socket.off('user-joined', handleUserJoined);
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('remoteVideoStateChange', handleRemoteVideoStateChange); // NEW
      socket.off('user-disconnected', handleUserDisconnected);
      socket.off('room-not-found', handleRoomNotFound);
      socket.off('room-created');
    };
  }, [socket]);

  const createRoom = async () => {
    if (!socket) return;
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
    if (!idToJoin || !socket) {
      setError('Please enter a Room ID');
      return;
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

    const peer = new RTCPeerConnection({
      iceServers,
    });

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
          // If stream exists, update it. Keep existing videoActive status or set default if not present.
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
          // Add new remote video with default videoActive as true (will be updated by initial-video-states)
          return [
            ...prev,
            { id: userId, stream: streams[0], videoActive: true },
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

    const peer = new RTCPeerConnection({
      iceServers,
    });

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
          // If stream exists, update it. Keep existing videoActive status or set default if not present.
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
          // Add new remote video with default videoActive as true (will be updated by initial-video-states or remoteVideoStateChange)
          return [
            ...prev,
            { id: userId, stream: streams[0], videoActive: true },
          ];
        }
      });
    };

    return peer;
  };

  const leaveRoom = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }

    Object.values(peersRef.current).forEach((peer) => {
      if (peer) peer.close();
    });

    peersRef.current = {};
    setRemoteVideos([]);
    setJoined(false);
    setIsCreator(false);
    setRoomId('');
    setRoomUrl('');
    setError('');
    setParticipantCount(1); // Reset participant count

    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    console.log('Left room.');
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
      // No socket emission for mute/unmute if you only want to update local UI.
      // If you want to show mute status for remote users, you'd emit a 'muteStateChange' event.
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      const newVideoState = !isVideoEnabled;
      setIsVideoEnabled(newVideoState);

      // NEW: Emit video state change to the server
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
        <div className="relative flex-1 flex flex-col p-4 bg-gray-900 overflow-hidden">
          <div className="flex-1 relative flex items-center justify-center rounded-lg overflow-hidden group bg-gray-800">
            <div className="absolute inset-0 w-full h-full bg-gray-800 filter blur-lg scale-110"></div>

            {remoteVideos.length > 0 ? (
              remoteVideos.map(
                (
                  { id, stream, videoActive } // Pass videoActive prop
                ) => (
                  <div key={id} className="relative w-full h-full z-10">
                    <Video
                      stream={stream}
                      userId={id}
                      mirror={true}
                      videoActive={videoActive}
                    />
                    <p className="absolute bottom-4 left-4 text-white text-base font-medium bg-black bg-opacity-50 px-3 py-1 rounded-md z-20">
                      {id.substring(0, 6)}...
                    </p>
                  </div>
                )
              )
            ) : (
              <div className="relative flex items-center justify-center w-full h-full text-gray-500 text-2xl z-10">
                Waiting for others to join...
              </div>
            )}
          </div>

          {localStream && (
            <div
              className="absolute bottom-4 right-4
                          w-40 h-30
                          md:w-60 md:h-40
                          lg:w-72 lg:h-48
                          rounded-lg overflow-hidden z-20 m-4"
            >
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
            </div>
          )}
        </div>
      )}

      {joined && (
        <div className="mx-4 rounded-t-lg bg-gray-800 p-3 flex justify-center items-center z-30">
          <div className="flex-1 flex items-center justify-start gap-2 pl-3 text-gray-300">
            <p className="text-sm">
              Room ID :{' '}
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
            <span className="text-lg font-medium">{participantCount}</span>
          </div>
        </div>
      )}
    </div>
  );
};

// Modified Video component
const Video = ({ stream, userId, mirror = false, videoActive }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current && !stream) {
      // If stream is null, clear srcObject
      videoRef.current.srcObject = null;
    }
    // The videoActive prop now directly controls the display,
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
