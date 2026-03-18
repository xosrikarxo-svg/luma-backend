const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// waiting pool: { userId, tags, ws }
const waitingPool = [];
// active sessions: userId -> { sessionId, peerId, peerWs }
const activeSessions = new Map();
// connections: userId -> ws
const connections = new Map();

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
const send = (ws, data) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };

function tryMatch(userId, tags, ws) {
  // Find someone in pool with at least one matching tag
  const idx = waitingPool.findIndex(u =>
    u.userId !== userId && u.tags.some(t => tags.includes(t))
  );

  if (idx !== -1) {
    const peer = waitingPool.splice(idx, 1)[0];
    const sessionId = uuidv4();
    const prompt = randPrompt();

    activeSessions.set(userId, { sessionId, peerId: peer.userId, peerWs: peer.ws });
    activeSessions.set(peer.userId, { sessionId, peerId: userId, peerWs: ws });

    send(ws, { type: 'matched', sessionId, prompt });
    send(peer.ws, { type: 'matched', sessionId, prompt });
  } else {
    // Add to waiting pool
    const already = waitingPool.findIndex(u => u.userId === userId);
    if (already === -1) waitingPool.push({ userId, tags, ws });
    send(ws, { type: 'waiting' });
  }
}

function endSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const { peerId, peerWs } = session;
  send(peerWs, { type: 'peer_left' });
  activeSessions.delete(userId);
  activeSessions.delete(peerId);
}

function removeFromQueue(userId) {
  const i = waitingPool.findIndex(u => u.userId === userId);
  if (i !== -1) waitingPool.splice(i, 1);
}

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      userId = uuidv4();
      connections.set(userId, ws);
      send(ws, { type: 'joined', userId });
      tryMatch(userId, msg.tags || [], ws);
    }

    if (msg.type === 'message') {
      const session = activeSessions.get(userId);
      if (!session) return;
      send(session.peerWs, { type: 'message', text: msg.text });
    }

    if (msg.type === 'typing') {
      const session = activeSessions.get(userId);
      if (!session) return;
      send(session.peerWs, { type: 'typing' });
    }

    if (msg.type === 'new_prompt') {
      const session = activeSessions.get(userId);
      if (!session) return;
      const prompt = randPrompt();
      send(ws, { type: 'prompt', prompt });
      send(session.peerWs, { type: 'prompt', prompt });
    }

    if (msg.type === 'leave') {
      endSession(userId);
      removeFromQueue(userId);
    }
  });

  ws.on('close', () => {
    if (!userId) return;
    connections.delete(userId);
    removeFromQueue(userId);
    endSession(userId);
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', waiting: waitingPool.length, active: activeSessions.size / 2 }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Luma backend running on http://localhost:${PORT}`));
