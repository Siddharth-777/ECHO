const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// serve /public
app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// --- WS signaling ---
const wss = new WebSocketServer({ server, path: "/ws" });

// rooms: { [roomId]: { [clientId]: ws } }
const rooms = {};

function broadcast(roomId, messageObj, excludeId = null) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify(messageObj);
  for (const [id, sock] of Object.entries(room)) {
    if (excludeId && id === excludeId) continue;
    if (sock.readyState === 1) sock.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.id = uuidv4();
  ws.room = null;
  ws.name = "Guest";

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "join") {
      const { roomId, name } = data;
      ws.room = roomId;
      ws.name = name || "Guest";
      if (!rooms[roomId]) rooms[roomId] = {};
      rooms[roomId][ws.id] = ws;

      // tell the new client about existing peers
      ws.send(JSON.stringify({
        type: "joined",
        clientId: ws.id,
        roomId,
        name: ws.name,
        peers: Object.entries(rooms[roomId])
          .filter(([id]) => id !== ws.id)
          .map(([id, s]) => ({ id, name: s.name }))
      }));

      // tell others that a new peer arrived
      broadcast(roomId, { type: "peer-joined", peer: { id: ws.id, name: ws.name } }, ws.id);
      return;
    }

    // signaling relay: offer/answer/candidates go to a specific peer
    if (["offer", "answer", "ice-candidate"].includes(data.type)) {
      const target = rooms[ws.room]?.[data.to];
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({ ...data, from: ws.id, name: ws.name }));
      }
      return;
    }

    // chat: send to everyone (including sender for uniform handling)
    if (data.type === "chat") {
      broadcast(ws.room, { type: "chat", from: ws.id, name: ws.name, text: data.text });
      return;
    }
  });

  ws.on("close", () => {
    const { room } = ws;
    if (room && rooms[room]) {
      delete rooms[room][ws.id];
      broadcast(room, { type: "peer-left", id: ws.id });
      if (Object.keys(rooms[room]).length === 0) delete rooms[room];
    }
  });
});
