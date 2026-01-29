const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Handle joining a specific whiteboard room
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
        // Optionally notify others in the room
    });

    // Handle drawing events
    socket.on('drawing', (data) => {
        // Broadcast to other users in the same room
        socket.to(data.roomId).emit('drawing', data);
    });

    // Handle clear board event
    socket.on('clear-board', (roomId) => {
        io.to(roomId).emit('clear-board');
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
