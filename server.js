const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

const waitingPool = [];
const activeSessions = new Map();
const reconnectPool = new Map();

const PROMPTS = [
  "What's something you've been thinking about lately?",
  "If you could master any skill instantly, what would it be?",
  "What's the last thing that genuinely made you laugh?",
  "What's something small that always improves your mood?",
  "If you had a completely free day tomorrow, what would you do?",
  "What's something you've changed your mind about recently?",
  "What's a place that made you feel completely at home?",
  "What's something you wish more people talked about?",
  "What's the most interesting thing you've learned this week?",
  "What does a perfect evening look like for you?",
];

const randPrompt = () => PROMPTS[Math.floor(Math.random() * PROMPTS.length)];

function createSession(idA, idB) {
  const sessionId = uuidv4();
  const prompt = randPrompt();
  activeSessions.set(idA, { sessionId, peerId: idB });
  activeSessions.set(idB, { sessionId, peerId: idA });
  io.to(idA).emit('matched', { sessionId, prompt });
  io.to(idB).emit('matched', { sessionId, prompt });
}

function tryMatch(userId, tags) {
  const idx = waitingPool.findIndex(u =>
    u.userId !== userId && u.tags.some(t => tags.includes(t))
  );
  if (idx !== -1) {
    const peer = waitingPool.splice(idx, 1)[0];
    createSession(userId, peer.userId);
  } else {
    const already = waitingPool.findIndex(u => u.userId === userId);
    if (already === -1) waitingPool.push({ userId, tags });
    io.to(userId).emit('waiting');
  }
}

function endSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const { peerId } = session;
  // Tell Person A who their peer was (so they can reconnect)
  io.to(userId).emit('session_ended', { peerId });
  // Tell Person B who left (so they can reconnect)
  io.to(peerId).emit('peer_left', { peerId: userId });
  activeSessions.delete(userId);
  activeSessions.delete(peerId);
}

function removeFromQueue(userId) {
  const i = waitingPool.findIndex(u => u.userId === userId);
  if (i !== -1) waitingPool.splice(i, 1);
}

function clearReconnect(userId) {
  const entry = reconnectPool.get(userId);
  if (entry) { clearTimeout(entry.timer); reconnectPool.delete(userId); }
}

io.on('connection', (socket) => {
  const userId = socket.id;

  socket.on('join', ({ tags }) => tryMatch(userId, tags || []));

  socket.on('message', ({ text }) => {
    const session = activeSessions.get(userId);
    if (!session) return;
    io.to(session.peerId).emit('message', { text });
  });

  socket.on('typing', () => {
    const session = activeSessions.get(userId);
    if (!session) return;
    io.to(session.peerId).emit('typing');
  });

  socket.on('new_prompt', () => {
    const session = activeSessions.get(userId);
    if (!session) return;
    const prompt = randPrompt();
    io.to(userId).emit('prompt', { prompt });
    io.to(session.peerId).emit('prompt', { prompt });
  });

  socket.on('leave', () => {
    endSession(userId);
    removeFromQueue(userId);
  });

  socket.on('reconnect_request', ({ peerId: targetId }) => {
    io.to(targetId).emit('reconnect_incoming', { fromId: userId });
    const timer = setTimeout(() => {
      reconnectPool.delete(userId);
      io.to(userId).emit('reconnect_expired');
      io.to(targetId).emit('reconnect_expired');
    }, 15000);
    reconnectPool.set(userId, { peerId: targetId, timer });
  });

  socket.on('reconnect_accept', ({ fromId }) => {
    const entry = reconnectPool.get(fromId);
    if (entry && entry.peerId === userId) {
      clearTimeout(entry.timer);
      reconnectPool.delete(fromId);
      clearReconnect(userId);
      createSession(userId, fromId);
    }
  });

  socket.on('reconnect_decline', ({ fromId }) => {
    clearReconnect(fromId);
    io.to(fromId).emit('reconnect_declined');
  });

  socket.on('disconnect', () => {
    removeFromQueue(userId);
    endSession(userId);
    clearReconnect(userId);
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', waiting: waitingPool.length, active: activeSessions.size / 2 }));

app.get('/queue-status', (_, res) => {
  const counts = {};
  waitingPool.forEach(u => {
    u.tags.forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
  });
  res.json(counts);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Luma running on port ${PORT}`));
