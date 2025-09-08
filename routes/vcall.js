const express = require("express");
const router = express.Router();

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Route to check active rooms
router.get("/active-rooms", (req, res) => {
  const activeRooms = Array.from(rooms.entries()).map(([roomId, users]) => ({
    roomId,
    userCount: users.size,
    users: Array.from(users).map((socketId) => ({
      socketId,
      userId: users.get(socketId)?.userId,
    })),
  }));
  res.json({ activeRooms });
});

// Socket.io setup function
function setupVideoCallSocket(io) {
  // Socket.io connection handling
  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Join a room
    socket.on("join-room", (data) => {
      const { roomId, userId } = data;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      rooms.get(roomId).add(socket.id);
      users.set(socket.id, { roomId, userId });

      socket.join(roomId);
      console.log(`User ${userId} joined room ${roomId}`);

      // Notify others in the room
      socket.to(roomId).emit("user-joined", { userId, socketId: socket.id });

      // Send list of existing users in the room
      const existingUsers = Array.from(rooms.get(roomId))
        .filter((id) => id !== socket.id)
        .map((id) => ({ socketId: id, userId: users.get(id)?.userId }));

      socket.emit("existing-users", existingUsers);
    });

    // Handle WebRTC offer
    socket.on("offer", (data) => {
      const { targetSocketId, offer } = data;
      socket.to(targetSocketId).emit("offer", {
        offer,
        senderSocketId: socket.id,
      });
    });

    // Handle WebRTC answer
    socket.on("answer", (data) => {
      const { targetSocketId, answer } = data;
      socket.to(targetSocketId).emit("answer", {
        answer,
        senderSocketId: socket.id,
      });
    });

    // Handle ICE candidates
    socket.on("ice-candidate", (data) => {
      const { targetSocketId, candidate } = data;
      socket.to(targetSocketId).emit("ice-candidate", {
        candidate,
        senderSocketId: socket.id,
      });
    });

    // Handle user leaving
    socket.on("leave-room", () => {
      const userData = users.get(socket.id);
      if (userData) {
        const { roomId, userId } = userData;

        if (rooms.has(roomId)) {
          rooms.get(roomId).delete(socket.id);
          if (rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
          }
        }

        socket.to(roomId).emit("user-left", { userId, socketId: socket.id });
        users.delete(socket.id);

        console.log(`User ${userId} left room ${roomId}`);
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      const userData = users.get(socket.id);
      if (userData) {
        const { roomId, userId } = userData;

        if (rooms.has(roomId)) {
          rooms.get(roomId).delete(socket.id);
          if (rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
          }
        }

        socket.to(roomId).emit("user-left", { userId, socketId: socket.id });
        users.delete(socket.id);

        console.log(`User ${userId} disconnected from room ${roomId}`);
      }
    });
  });
}

// Export both the router and socket setup function
module.exports = {
  router,
  setupVideoCallSocket,
};
