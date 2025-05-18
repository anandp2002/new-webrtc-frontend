import React, { useRef, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  UserPlus,
  LogOut,
} from 'lucide-react';

const App = () => {
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

  const BASE_URL = import.meta.env.VITE_BASE_URL;
  const STUN_TURN_SERVER = import.meta.env.VITE_STUN_TURN_SERVER;
  const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME;
  const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD;

  // Setup local video once joined and stream is available
  useEffect(() => {
    if (joined && localStreamRef.current && localVideoRef.current) {
      console.log('Setting up local video element with stream');
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [joined, localStream]);

  // Initialize socket and setup listeners only once
  useEffect(() => {
    const newSocket = io(BASE_URL);
    setSocket(newSocket);

    // Handle connection errors
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
  }, []);

  // Setup socket event handlers once socket is set
  useEffect(() => {
    if (!socket) return;

    const handleAllUsers = (users) => {
      console.log('Received all users:', users);
      users.forEach((userId) => {
        const peer = createPeer(userId, socket.id, localStreamRef.current);
        peersRef.current[userId] = peer;
      });
    };

    const handleUserJoined = (userId) => {
      console.log('User joined:', userId);
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

    const handleUserDisconnected = (userId) => {
      console.log('User disconnected:', userId);
      if (peersRef.current[userId]) {
        peersRef.current[userId].close();
        delete peersRef.current[userId];
        setRemoteVideos((prev) => prev.filter((v) => v.id !== userId));
      }
    };

    socket.on('all-users', handleAllUsers);
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('user-disconnected', handleUserDisconnected);

    return () => {
      socket.off('all-users', handleAllUsers);
      socket.off('user-joined', handleUserJoined);
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('user-disconnected', handleUserDisconnected);
    };
  }, [socket]);

  const createRoom = () => {
    const newRoomId = uuidv4();
    setRoomId(newRoomId);
    console.log('Created room with ID:', newRoomId);

    // Generate a shareable URL
    const url = `${window.location.origin}?room=${newRoomId}`;
    setRoomUrl(url);

    // Optional: copy to clipboard for easy sharing
    navigator.clipboard
      .writeText(url)
      .then(() => {
        console.log('Room URL copied to clipboard');
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 3000);
      })
      .catch((err) => console.error('Could not copy room URL:', err));
  };

  const joinRoom = async () => {
    if (!roomId || !socket) {
      setError('Please enter a Room ID');
      return;
    }

    try {
      setError('');
      console.log('Attempting to join room:', roomId);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      console.log('Got media stream:', stream);
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Wait for the next render cycle before setting srcObject
      setTimeout(() => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          console.log('Set local video source:', stream.id);
        } else {
          console.warn('Local video ref is not available');
        }
      }, 0);

      socket.emit('join-room', { roomId });
      setJoined(true);
      console.log('Successfully joined room:', roomId);
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setError(`Error accessing camera or microphone: ${error.message}`);
    }
  };

  // Check URL for room ID on component mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  const createPeer = (userId, callerId, stream) => {
    console.log('Creating peer for user:', userId);
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:' + STUN_TURN_SERVER },

        // TURN servers configuration
        {
          urls: 'turn:' + STUN_TURN_SERVER,
          username: TURN_USERNAME,
          credential: TURN_PASSWORD,
        },
      ],
    });

    if (stream) {
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    } else {
      console.warn('No local stream available when creating peer');
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
            v.id === userId ? { id: userId, stream: streams[0] } : v
          );
        } else {
          return [...prev, { id: userId, stream: streams[0] }];
        }
      });
    };

    // Create and send offer
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
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:' + STUN_TURN_SERVER },

        // TURN servers configuration
        {
          urls: 'turn:' + STUN_TURN_SERVER,
          username: TURN_USERNAME,
          credential: TURN_PASSWORD,
        },
      ],
    });

    if (stream) {
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    } else {
      console.warn('No local stream available when adding peer');
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
            v.id === userId ? { id: userId, stream: streams[0] } : v
          );
        } else {
          return [...prev, { id: userId, stream: streams[0] }];
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

    // Close all peer connections
    Object.values(peersRef.current).forEach((peer) => {
      if (peer) peer.close();
    });

    peersRef.current = {};
    setRemoteVideos([]);
    setJoined(false);

    console.log('Left room:', roomId);
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsVideoEnabled(!isVideoEnabled);
    }
  };

  const copyRoomUrl = () => {
    navigator.clipboard.writeText(roomUrl).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 3000);
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-6xl bg-white shadow-2xl rounded-xl p-6 backdrop-blur-sm bg-opacity-90">
        {!joined ? (
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-3xl font-bold text-indigo-900 mb-2">
              Video Chat Room
            </h1>
            <p className="text-gray-600 text-center max-w-md">
              Connect with others through secure, high-quality video calls.
              Create a room or join with a room ID.
            </p>

            {error && (
              <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg relative w-full max-w-md">
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
                <div className="w-full bg-gray-100 p-3 rounded-lg flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={roomUrl}
                    readOnly
                    className="bg-transparent flex-1 outline-none text-sm text-gray-700"
                  />
                  <button
                    onClick={copyRoomUrl}
                    className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
                  >
                    {isCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2 w-full">
                <hr className="flex-1 border-gray-300" />
                <span className="text-gray-500">or</span>
                <hr className="flex-1 border-gray-300" />
              </div>

              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="Enter Room ID"
                className="border border-gray-300 rounded-lg px-4 py-3 w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
              />
              <button
                onClick={joinRoom}
                disabled={!roomId}
                className={`${
                  roomId
                    ? 'bg-indigo-600 hover:bg-indigo-700'
                    : 'bg-gray-400 cursor-not-allowed'
                } text-white px-6 py-3 rounded-lg transition duration-300 w-full font-medium shadow-md`}
              >
                Join Room
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-bold text-indigo-900">
                  Video Chat
                </h2>
                <p className="text-sm text-gray-600">
                  Room ID:{' '}
                  <span className="font-medium text-indigo-600">{roomId}</span>
                </p>
              </div>
              <button
                onClick={leaveRoom}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition duration-300 text-sm font-medium shadow flex items-center gap-1"
              >
                <LogOut size={16} /> Leave Room
              </button>
            </div>

            <div className="flex flex-wrap justify-center gap-4 mb-6">
              {localStream && (
                <div className="relative">
                  <div className="overflow-hidden rounded-lg shadow-lg bg-black relative">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      width="320"
                      height="240"
                      className={`${!isVideoEnabled ? 'invisible' : ''}`}
                    />
                    {!isVideoEnabled && (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-800 text-white">
                        <div className="text-center">
                          <div className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-2">
                            <span className="text-xl font-bold">You</span>
                          </div>
                          <p>Camera Off</p>
                        </div>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-center text-sm font-medium">
                    You {socket && `(${socket.id?.substring(0, 6)}...)`}
                  </p>
                </div>
              )}

              {remoteVideos.map(({ id, stream }) => (
                <div key={id} className="relative">
                  <Video stream={stream} />
                  <p className="mt-2 text-center text-sm font-medium">
                    {id.substring(0, 6)}...
                  </p>
                </div>
              ))}

              {joined && remoteVideos.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500 w-full">
                  <div className="w-20 h-20 rounded-full bg-indigo-100 flex items-center justify-center mb-4">
                    <UserPlus size={32} className="text-indigo-600" />
                  </div>
                  <p className="text-lg font-medium text-indigo-900">
                    Waiting for others to join...
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    Share your Room ID with others to invite them
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(roomId);
                      setIsCopied(true);
                      setTimeout(() => setIsCopied(false), 3000);
                    }}
                    className="mt-4 text-indigo-600 hover:text-indigo-800 text-sm font-medium flex items-center gap-1"
                  >
                    {isCopied ? 'Copied!' : 'Copy Room ID'}
                  </button>
                </div>
              )}
            </div>

            {joined && (
              <div className="fixed bottom-0 left-0 right-0 bg-white bg-opacity-95 p-4 shadow-lg flex justify-center">
                <div className="flex items-center gap-4">
                  <button
                    onClick={toggleMute}
                    className={`p-3 rounded-full transition ${
                      isMuted
                        ? 'bg-red-100 text-red-600'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    }`}
                    title={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                  </button>

                  <button
                    onClick={toggleVideo}
                    className={`p-3 rounded-full transition ${
                      !isVideoEnabled
                        ? 'bg-red-100 text-red-600'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    }`}
                    title={
                      isVideoEnabled ? 'Turn off camera' : 'Turn on camera'
                    }
                  >
                    {isVideoEnabled ? (
                      <VideoIcon size={24} />
                    ) : (
                      <VideoOff size={24} />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const Video = ({ stream }) => {
  const ref = useRef(null);
  const [videoActive, setVideoActive] = useState(true);

  useEffect(() => {
    if (ref.current && stream) {
      console.log('Setting remote video stream');
      ref.current.srcObject = stream;

      // Check if the video track is enabled
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        setVideoActive(videoTrack.enabled);

        // Listen for enabled/disabled changes
        const trackListener = () => {
          setVideoActive(videoTrack.enabled);
        };

        videoTrack.addEventListener('mute', () => setVideoActive(false));
        videoTrack.addEventListener('unmute', () => setVideoActive(true));

        return () => {
          videoTrack.removeEventListener('mute', trackListener);
          videoTrack.removeEventListener('unmute', trackListener);
        };
      }
    }
  }, [stream]);

  return (
    <div className="overflow-hidden rounded-lg shadow-lg bg-black relative">
      <video
        ref={ref}
        autoPlay
        playsInline
        width="320"
        height="240"
        className={`${!videoActive ? 'invisible' : ''}`}
      />
      {!videoActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 text-white">
          <div className="text-center">
            <div className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-2">
              <span className="text-xl font-bold">User</span>
            </div>
            <p>Camera Off</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
