const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

// Store active calls and users
const activeCalls = new Map(); // callId -> call data
const userSockets = new Map(); // userId -> socketId mapping
const socketUsers = new Map(); // socketId -> userId mapping

// Route to check active calls
router.get("/active-calls", (req, res) => {
  const activeCallsList = Array.from(activeCalls.entries()).map(
    ([callId, callData]) => ({
      callId,
      caller: callData.caller,
      recipient: callData.recipient,
      status: callData.status,
      type: callData.type,
      timestamp: callData.timestamp,
    })
  );
  res.json({ activeCalls: activeCallsList });
});

// Socket.io setup function
function setupVideoCallSocket(io) {
  // Setup authentication middleware for video calls
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        console.log("❌ No token provided for video call");
        return next(new Error("Authentication error: No token provided"));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userPhone = decoded.phoneNumber;

      console.log(
        `✅ Video call socket authenticated for user: ${socket.userId}`
      );
      next();
    } catch (error) {
      console.log("❌ Video call socket authentication failed:", error.message);
      next(new Error("Authentication error: Invalid token"));
    }
  });

  // Socket.io connection handling
  io.on("connection", (socket) => {
    console.log(
      `📹 Video call user ${socket.userId} connected with socket ${socket.id}`
    );

    // Store user socket mapping
    userSockets.set(socket.userId, socket.id);
    socketUsers.set(socket.id, socket.userId);

    // Join user to their personal room
    socket.join(`user_${socket.userId}`);

    // Send connection confirmation
    socket.emit("connected", {
      userId: socket.userId,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });

    // Handle heartbeat/ping
    socket.on("ping", () => {
      socket.emit("pong", { timestamp: new Date().toISOString() });
    });

    // Handle outgoing call
    socket.on("outgoing-call", (data) => {
      try {
        console.log(`📞 Outgoing call from ${socket.userId}:`, data);

        const { callId, recipientId, callType, caller } = data;

        // Validate required fields
        if (!callId || !recipientId || !callType || !caller) {
          console.log("❌ Missing required fields:", {
            callId,
            recipientId,
            callType,
            caller: !!caller,
          });
          socket.emit("call_error", { error: "Missing required fields" });
          return;
        }

        // Store call data
        activeCalls.set(callId, {
          callId,
          caller,
          recipientId,
          type: callType,
          status: "outgoing",
          timestamp: new Date().toISOString(),
          callerSocketId: socket.id,
        });

        console.log(`📝 Call stored with ID: ${callId}`);
        console.log(`👥 Active users:`, Array.from(userSockets.keys()));

        // Emit to caller (confirmation)
        socket.emit("call_initiated", {
          callId,
          status: "calling",
        });

        // Emit to recipient if they're online
        const recipientSocketId = userSockets.get(recipientId);
        console.log(
          `🔍 Looking for recipient ${recipientId}, found socket: ${recipientSocketId}`
        );

        if (recipientSocketId) {
          console.log(`📱 Sending incoming call to ${recipientId}`);
          io.to(recipientSocketId).emit("incoming-call", {
            callId,
            caller,
            callType,
            timestamp: new Date().toISOString(),
          });
          console.log(`✅ Incoming call sent successfully`);
        } else {
          // Recipient is offline
          console.log(`❌ Recipient ${recipientId} is offline`);
          socket.emit("call_error", { error: "Recipient is offline" });
          activeCalls.delete(callId);
        }
      } catch (error) {
        console.error("❌ Outgoing call error:", error);
        socket.emit("call_error", { error: "Failed to initiate call" });
      }
    });

    // Handle call acceptance
    socket.on("accept-call", (data) => {
      try {
        const { callId, callerId, accepterId } = data;

        console.log(`✅ Call accepted: ${callId} by ${accepterId}`);

        const callData = activeCalls.get(callId);
        if (!callData) {
          socket.emit("call_error", { error: "Call not found" });
          return;
        }

        // Update call status
        callData.status = "accepted";
        callData.accepterSocketId = socket.id;
        activeCalls.set(callId, callData);

        // Notify caller
        const callerSocketId = userSockets.get(callerId);
        if (callerSocketId) {
          io.to(callerSocketId).emit("call-accepted", {
            callId,
            accepterId,
            timestamp: new Date().toISOString(),
          });
        }

        // Notify accepter
        socket.emit("call-accepted", {
          callId,
          status: "accepted",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("❌ Call accept error:", error);
        socket.emit("call_error", { error: "Failed to accept call" });
      }
    });

    // Handle call rejection
    socket.on("reject-call", (data) => {
      try {
        const { callId, callerId, rejecterId } = data;

        console.log(`❌ Call rejected: ${callId} by ${rejecterId}`);

        const callData = activeCalls.get(callId);
        if (!callData) {
          socket.emit("call_error", { error: "Call not found" });
          return;
        }

        // Update call status
        callData.status = "rejected";
        activeCalls.set(callId, callData);

        // Notify caller
        const callerSocketId = userSockets.get(callerId);
        if (callerSocketId) {
          io.to(callerSocketId).emit("call-rejected", {
            callId,
            rejecterId,
            timestamp: new Date().toISOString(),
          });
        }

        // Clean up call data after a delay
        setTimeout(() => {
          activeCalls.delete(callId);
        }, 5000);
      } catch (error) {
        console.error("❌ Call reject error:", error);
        socket.emit("call_error", { error: "Failed to reject call" });
      }
    });

    // Handle call end
    socket.on("end-call", (data) => {
      try {
        const { callId, userId } = data;

        console.log(`📴 Call ended: ${callId} by ${userId}`);

        const callData = activeCalls.get(callId);
        if (!callData) {
          return;
        }

        // Notify both parties
        const callerSocketId = userSockets.get(callData.caller.id);
        const recipientSocketId = userSockets.get(callData.recipientId);

        if (callerSocketId) {
          io.to(callerSocketId).emit("call-ended", {
            callId,
            endedBy: userId,
            timestamp: new Date().toISOString(),
          });
        }

        if (recipientSocketId) {
          io.to(recipientSocketId).emit("call-ended", {
            callId,
            endedBy: userId,
            timestamp: new Date().toISOString(),
          });
        }

        // Clean up call data
        activeCalls.delete(callId);
      } catch (error) {
        console.error("❌ Call end error:", error);
      }
    });

    // Handle WebRTC offer
    socket.on("offer", (data) => {
      try {
        const { callId, offer, targetUserId } = data;

        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
          io.to(targetSocketId).emit("offer", {
            callId,
            offer,
            senderId: socket.userId,
          });
        }
      } catch (error) {
        console.error("❌ Offer error:", error);
      }
    });

    // Handle WebRTC answer
    socket.on("answer", (data) => {
      try {
        const { callId, answer, targetUserId } = data;

        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
          io.to(targetSocketId).emit("answer", {
            callId,
            answer,
            senderId: socket.userId,
          });
        }
      } catch (error) {
        console.error("❌ Answer error:", error);
      }
    });

    // Handle ICE candidates
    socket.on("ice-candidate", (data) => {
      try {
        const { callId, candidate, targetUserId } = data;

        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
          io.to(targetSocketId).emit("ice-candidate", {
            callId,
            candidate,
            senderId: socket.userId,
          });
        }
      } catch (error) {
        console.error("❌ ICE candidate error:", error);
      }
    });

    // Handle disconnect
    socket.on("disconnect", (reason) => {
      try {
        console.log(
          `📹 Video call user ${socket.userId} disconnected: ${reason}`
        );

        // Remove from mappings
        userSockets.delete(socket.userId);
        socketUsers.delete(socket.id);

        // End any active calls for this user
        for (const [callId, callData] of activeCalls.entries()) {
          if (
            callData.caller.id === socket.userId ||
            callData.recipientId === socket.userId
          ) {
            // Notify the other party
            const otherUserId =
              callData.caller.id === socket.userId
                ? callData.recipientId
                : callData.caller.id;
            const otherSocketId = userSockets.get(otherUserId);

            if (otherSocketId) {
              io.to(otherSocketId).emit("call-ended", {
                callId,
                endedBy: socket.userId,
                reason: "disconnected",
                timestamp: new Date().toISOString(),
              });
            }

            // Clean up call data
            activeCalls.delete(callId);
          }
        }
      } catch (error) {
        console.error("❌ Video call disconnect error:", error);
      }
    });

    // Handle errors
    socket.on("error", (error) => {
      console.error(
        `❌ Video call socket error for user ${socket.userId}:`,
        error
      );
    });
  });
}

// Export both the router and socket setup function
module.exports = {
  router,
  setupVideoCallSocket,
};
