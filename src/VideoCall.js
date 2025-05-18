// src/VideoCall.js
import React, { useEffect, useRef } from 'react';
import io from 'socket.io-client';

const VideoCall = ({ roomId }) => {
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);

  useEffect(() => {
    socketRef.current = io('http://localhost:5000');

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        localVideoRef.current.srcObject = stream;
        localStreamRef.current = stream;

        socketRef.current.emit('join', roomId);

        socketRef.current.on('other-user', (userId) => {
          callUser(userId);
        });

        socketRef.current.on('user-joined', (userId) => {
          console.log('User joined:', userId);
        });

        socketRef.current.on('offer', handleReceiveOffer);
        socketRef.current.on('answer', handleReceiveAnswer);
        socketRef.current.on('ice-candidate', handleNewICECandidateMsg);
      });

    return () => {
      socketRef.current.disconnect();
    };
  }, []);

  const callUser = (userId) => {
    peerConnectionRef.current = createPeerConnection(userId);

    localStreamRef.current
      .getTracks()
      .forEach((track) =>
        peerConnectionRef.current.addTrack(track, localStreamRef.current)
      );

    peerConnectionRef.current
      .createOffer()
      .then((offer) => {
        return peerConnectionRef.current.setLocalDescription(offer);
      })
      .then(() => {
        socketRef.current.emit('offer', {
          target: userId,
          caller: socketRef.current.id,
          sdp: peerConnectionRef.current.localDescription,
        });
      });
  };

  const createPeerConnection = (userId) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: 'stun:stun.l.google.com:19302',
        },
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit('ice-candidate', {
          target: userId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0];
    };

    return pc;
  };

  const handleReceiveOffer = (incoming) => {
    peerConnectionRef.current = createPeerConnection(incoming.caller);

    localStreamRef.current
      .getTracks()
      .forEach((track) =>
        peerConnectionRef.current.addTrack(track, localStreamRef.current)
      );

    peerConnectionRef.current
      .setRemoteDescription(new RTCSessionDescription(incoming.sdp))
      .then(() => {
        return peerConnectionRef.current.createAnswer();
      })
      .then((answer) => {
        return peerConnectionRef.current.setLocalDescription(answer);
      })
      .then(() => {
        socketRef.current.emit('answer', {
          target: incoming.caller,
          sdp: peerConnectionRef.current.localDescription,
        });
      });
  };

  const handleReceiveAnswer = (message) => {
    const desc = new RTCSessionDescription(message.sdp);
    peerConnectionRef.current
      .setRemoteDescription(desc)
      .catch((e) => console.log(e));
  };

  const handleNewICECandidateMsg = (incoming) => {
    const candidate = new RTCIceCandidate(incoming.candidate);
    peerConnectionRef.current
      .addIceCandidate(candidate)
      .catch((e) => console.log(e));
  };

  return (
    <div className="flex justify-center items-center h-screen space-x-4">
      <video ref={localVideoRef} autoPlay playsInline muted className="w-1/2" />
      <video ref={remoteVideoRef} autoPlay playsInline className="w-1/2" />
    </div>
  );
};

export default VideoCall;
