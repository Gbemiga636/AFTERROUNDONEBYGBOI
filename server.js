// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/afterroundone";
const PORT = process.env.PORT || 5000;

/* -------------------------
   Mongoose models
   ------------------------- */
const roomSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  createdBy: String,
  started: { type: Boolean, default: false },
  round: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const playerSchema = new mongoose.Schema({
  roomCode: String,
  name: String,
  number: Number,       // stored number chosen at joining
  isHost: Boolean,
  status: { type: String, default: "alive" }, // alive / eliminated
  joinedAt: { type: Date, default: Date.now }
}, { versionKey: false });

const Room = mongoose.model("Room", roomSchema);
const Player = mongoose.model("Player", playerSchema);

/* -------------------------
   In-memory room state cache
   - stored to coordinate rounds / choices quickly
   - persisted players remain the source-of-truth for membership
   ------------------------- */
const roomStates = new Map();
/*
roomStates.set(code, {
  code,
  round: 0,
  status: "lobby" | "playing" | "ended",
  timer: null,            // NodeJS timeout id
  roundEndAt: null,       // timestamp when round ends
  players: {              // keyed by player name
    "Alice": { name, number, choice: null, qualified: false, status:"alive" }
  }
});
*/

/* -------------------------
   Setup Express + Socket.IO
   ------------------------- */
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
// Serve static frontend from /public
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

// Fallback for SPA: send index.html for any non-API route
// ✅ works in Express 5
app.get("/*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(publicPath, "index.html"));
});

/* -------------------------
   Helpers
   ------------------------- */
function makeCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function ensureRoomStateLoaded(code) {
  if (roomStates.has(code)) return roomStates.get(code);

  const room = await Room.findOne({ code }).lean();
  if (!room) return null;

  const players = await Player.find({ roomCode: code }).lean();
  const playersMap = {};
  players.forEach(p => {
    playersMap[p.name] = {
      name: p.name,
      number: p.number,
      isHost: !!p.isHost,
      choice: null,
      qualified: false,
      status: p.status || "alive"
    };
  });

  const state = {
    code,
    round: room.round || 0,
    status: room.started ? "playing" : "lobby",
    timer: null,
    roundEndAt: null,
    players: playersMap
  };
  roomStates.set(code, state);
  return state;
}

function broadcastPlayersUpdate(code) {
  // emit the canonical list of players to the room channel
  Player.find({ roomCode: code }).lean().then(players => {
    io.to(code).emit("players-updated", players);
  }).catch(err => {
    console.error("broadcastPlayersUpdate error:", err);
  });
}

function getActivePlayersList(state) {
  return Object.values(state.players).filter(p => p.status === "alive");
}

/* -------------------------
   REST API
   ------------------------- */

/**
 * Create room + host player
 * body: { name, number }
 */
app.post("/api/create-room", async (req, res) => {
  try {
    const { name, number } = req.body;
    if (!name || number == null) return res.status(400).json({ error: "Name & number required" });

    // generate unique code (simple retry loop)
    let code;
    for (let i = 0; i < 6; i++) {
      code = makeCode(6);
      const exists = await Room.findOne({ code }).lean();
      if (!exists) break;
      code = null;
    }
    if (!code) return res.status(500).json({ error: "Could not generate room code" });

    // create room and host
    await Room.create({ code, createdBy: name, started: false, round: 0 });
    await Player.create({ roomCode: code, name, number, isHost: true, status: "alive" });

    // ensure state cache
    await ensureRoomStateLoaded(code);

    broadcastPlayersUpdate(code);
    return res.json({ code, joinLink: `${req.protocol}://${req.get("host")}/join/${code}` });
  } catch (err) {
    console.error("create-room error:", err);
    return res.status(500).json({ error: err.message });
  }
});


/**
 * Join room (adds player)
 * body: { code, name, number }
 */
app.post("/api/join-room", async (req, res) => {
  try {
    const { code, name, number } = req.body;
    if (!code || !name || number == null) return res.status(400).json({ error: "code, name, number required" });

    const room = await Room.findOne({ code });
    if (!room) return res.status(404).json({ error: "Room not found" });

    // check name uniqueness (case-insensitive)
    const nameTaken = await Player.findOne({ roomCode: code, name: { $regex: `^${name}$`, $options: "i" } });
    if (nameTaken) return res.status(400).json({ error: "Name already taken" });

    // check number uniqueness
    const numberTaken = await Player.findOne({ roomCode: code, number });
    if (numberTaken) return res.status(400).json({ error: "Number already taken" });

    // add player
    await Player.create({ roomCode: code, name, number, isHost: false, status: "alive" });

    // update cache
    const state = await ensureRoomStateLoaded(code);
    if (state) {
      state.players[name] = { name, number, isHost: false, choice: null, qualified: false, status: "alive" };
    }

    broadcastPlayersUpdate(code);
    io.to(code).emit("update"); // backward compat
    return res.json({ success: true });
  } catch (err) {
    console.error("join-room error:", err);
    return res.status(500).json({ error: err.message });
  }
});


/**
 * Get players for lobby
 */
app.get("/api/room/:code/players", async (req, res) => {
  try {
    const players = await Player.find({ roomCode: req.params.code }).lean();
    return res.json(players);
  } catch (err) {
    console.error("get players error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Start game (host-only)
 */
app.post("/api/room/:code/start", async (req, res) => {
  try {
    const { code } = req.params;
    const { name: requester } = req.body || {}; // optional name of who requested
    const room = await Room.findOne({ code });
    if (!room) return res.status(404).json({ error: "Room not found" });

    // verify requester is host if provided
    if (requester) {
      const p = await Player.findOne({ roomCode: code, name: requester });
      if (!p || !p.isHost) return res.status(403).json({ error: "Only host can start the game" });
    }

    room.started = true;
    room.round = 0;
    await room.save();

    // ensure state
    const state = await ensureRoomStateLoaded(code);
    state.status = "playing";
    state.round = 0;

    io.to(code).emit("game-started");
    broadcastPlayersUpdate(code);
    return res.json({ success: true });
  } catch (err) {
    console.error("start-game error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Leave room
 * body: { name }
 */
app.post("/api/room/:code/leave", async (req, res) => {
  try {
    const { code } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    await Player.deleteOne({ roomCode: code, name });

    const state = await ensureRoomStateLoaded(code);
    if (state && state.players[name]) {
      delete state.players[name];
    }

    broadcastPlayersUpdate(code);
    io.to(code).emit("update");
    return res.json({ success: true });
  } catch (err) {
    console.error("leave error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Inspect full room server-state (useful for debugging)
 */
app.get("/api/room/:code/state", async (req, res) => {
  try {
    const state = await ensureRoomStateLoaded(req.params.code);
    if (!state) return res.status(404).json({ error: "Room not found" });
    return res.json(state);
  } catch (err) {
    console.error("state error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------
   Socket.IO realtime handlers
   ------------------------- */
/* -------------------------
   Socket.IO realtime handlers
   ------------------------- */
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id, "name:", socket.data?.name, "room:", socket.data?.roomCode);

  // join-room: payload can be either code or { code, name }
  socket.on("join-room", async (payload) => {
    try {
      const code = (typeof payload === "string") ? payload : payload?.code;
      const name = (typeof payload === "object" && payload?.name) ? payload.name : null;
      if (!code) return;

      socket.join(code);
      socket.data.roomCode = code;
      if (name) socket.data.name = name;

      // load state and emit players list + state
      const state = await ensureRoomStateLoaded(code);
      if (!state) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      // send current players list and state
      const players = await Player.find({ roomCode: code }).lean();
      socket.emit("players-updated", players);
      io.to(code).emit("game-state", {
        round: state.round,
        status: state.status,
        players: Object.values(state.players).map(p => ({
          name: p.name,
          number: p.number,
          status: p.status,
          qualified: p.qualified
        }))
      });
    } catch (err) {
      console.error("join-room socket error:", err);
    }
  });

  /**
   * start-round (socket)
   * payload: { code }
   * only host allowed (server checks DB for isHost based on socket.data.name if provided)
   */
  socket.on("start-round", async (payload) => {
    try {
      const code = payload?.code || socket.data.roomCode;
      if (!code) return;

      // check host rights if socket provided name
      if (socket.data?.name) {
        const p = await Player.findOne({ roomCode: code, name: socket.data.name }).lean();
        if (!p || !p.isHost) {
          socket.emit("error", { message: "Only host can start round" });
          return;
        }
      }

      const room = await Room.findOne({ code });
      if (!room) { socket.emit("error", { message: "Room not found" }); return; }

      // load state
      const state = await ensureRoomStateLoaded(code);
      state.round = (room.round || 0) + 1;
      room.round = state.round;
      room.started = true;
      await room.save();

      // reset per-player round choices
      for (const nm of Object.keys(state.players)) {
        state.players[nm].choice = null;
        state.players[nm].qualified = false;
      }

      state.status = "playing";
      const duration = 10;
      state.roundEndAt = Date.now() + duration * 1000;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      io.to(code).emit("round-start", { round: state.round, duration });

      state.timer = setTimeout(() => {
        resolveRound(code).catch(err => console.error("resolveRound timer error:", err));
      }, duration * 1000);

      await Room.updateOne({ code }, { $set: { round: state.round, started: true } });

      io.to(code).emit("game-state", {
        round: state.round,
        status: state.status,
        players: Object.values(state.players).map(p => ({
          name: p.name,
          number: p.number,
          status: p.status,
          qualified: p.qualified
        }))
      });
    } catch (err) {
      console.error("start-round error:", err);
    }
  });

  /**
   * play-number
   * payload: { code, name, number }
   */
  socket.on("play-number", async (payload) => {
    try {
      const code = payload?.roomCode || payload?.code || socket.data.roomCode;
      const name = payload?.name || socket.data.name;
      const number = payload?.number;

      if (!code || !name || number == null) return;

      const state = await ensureRoomStateLoaded(code);
      if (!state) { socket.emit("error", { message: "Room not found" }); return; }
      if (state.status !== "playing") { socket.emit("error", { message: "Round not active" }); return; }

      const player = state.players[name];
      if (!player) { socket.emit("error", { message: "Player not in room" }); return; }
      if (player.status !== "alive") { socket.emit("error", { message: "Player not alive" }); return; }

      player.choice = Number(number);

      io.to(code).emit("player-choice", { name, choice: player.choice });

      const activePlayers = getActivePlayersList(state);
      const allChosen = activePlayers.every(p => p.choice != null);

      if (allChosen) {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        await resolveRound(code);
      }
    } catch (err) {
      console.error("play-number error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("socket disconnect:", socket.id, "name:", socket.data?.name, "room:", socket.data?.roomCode);
  });
});
/* -------------------------
   Round resolution logic on server
   ------------------------- */
async function resolveRound(code) {
  const state = roomStates.get(code);
  if (!state) return;

  // gather active players (by current state cache)
  const active = getActivePlayersList(state);
  if (active.length === 0) {
    // nothing to do
    io.to(code).emit("round-results", { message: "No active players" });
    return;
  }

  // if some players have null choice, treat as random 1-5 (or 1..k; we use 1..5)
  active.forEach(p => {
    if (p.choice == null) p.choice = Math.floor(Math.random() * 5) + 1;
  });

  const total = active.reduce((s, p) => s + Number(p.choice), 0);

  // qualified players: stored number equals total
  const qualifiedNames = [];
  for (const p of active) {
    if (Number(p.number) === total) {
      p.qualified = true;
      qualifiedNames.push(p.name);
    } else {
      p.qualified = false;
    }
  }

  // determine elimination: if exactly one active player is not qualified => eliminate that one
  const nonQualified = active.filter(p => !p.qualified);
  const eliminatedNames = [];

  if (nonQualified.length === 1) {
    const loser = nonQualified[0];
    loser.status = "eliminated";
    eliminatedNames.push(loser.name);
    // persist elimination
    await Player.updateOne({ roomCode: code, name: loser.name }, { $set: { status: "eliminated" } });
    // remove from active players in state (we simply mark status)
  } else {
    // no immediate elimination this round - game continues
    // (You can implement different elimination rules here)
  }

  // update DB qualified flags? We keep per-player "qualified" ephemeral in state.
  // persist players statuses for eliminated players already done.

  // Update state.round maybe already set
  const playersArray = Object.values(state.players).map(p => ({
    name: p.name,
    number: p.number,
    choice: p.choice,
    qualified: p.qualified,
    status: p.status
  }));

  // Check winning condition: if only one alive left -> winner
  const aliveNow = playersArray.filter(p => p.status === "alive");
  let winner = null;
  if (aliveNow.length === 1) {
    winner = aliveNow[0].name;
    state.status = "ended";
    // persist room ended if desired
    await Room.updateOne({ code }, { $set: { started: false } });
    io.to(code).emit("game-ended", { winner });
  }

  // Emit results to room
  io.to(code).emit("round-results", {
    total,
    qualified: qualifiedNames,
    eliminated: eliminatedNames,
    players: playersArray,
    winner: winner || null,
    round: state.round
  });

  // persist any DB changes already persisted for eliminated
  // Clear choices for next round (keep qualified flag maybe)
  for (const p of Object.values(state.players)) {
    p.choice = null;
    p.qualified = false;
  }

  // broadcast players update (so lobby / clients can refresh)
  broadcastPlayersUpdate(code);
}

/* -------------------------
   Start server
   ------------------------- */
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });