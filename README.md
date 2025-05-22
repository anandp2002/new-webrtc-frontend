## Front end for WEBRTC

# Steps to install
1. git clone https://github.com/anandp2002/WEBRTC-frontend.git
2. cd WEBRTC-server
3. npm install
4. create a .env file and set environment variables  
    VITE_BASE_URL = http://localhost:5000 (or your backend url)  
    VITE_STUN_TURN_SERVER = your stun_turn server with port number (stun.l.google.com:19302)  
    VITE_TURN_USERNAME = your turn username  
    VITE_TURN_PASSWORD = your turn password  
6. npm run dev
