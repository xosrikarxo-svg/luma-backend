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

const waitingPool = [];
const activeSessions = new Map();
const connections = new Map();
const reconnectPool = new Map(); // userId -> { peerId, timer }

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

function createSession(userIdA, wsA, userIdB, wsB) {
  const sessionId = uuidv4();
  const prompt = randPrompt();
  activeSessions.set(userIdA, { sessionId, peerId: userIdB, peerWs: wsB });
  activeSessions.set(userIdB, { sessionId, peerId: userIdA, peerWs: wsA });
  send(wsA, { type: 'matched', sessionId, prompt });
  send(wsB, { type: 'matched', sessionId, prompt });
}

function tryMatch(userId, tags, ws) {
  const idx = waitingPool.findIndex(u =>
    u.userId !== userId && u.tags.some(t => tags.includes(t))
  );
  if (idx !== -1) {
    const peer = waitingPool.splice(idx, 1)[0];
    createSession(userId, ws, peer.userId, peer.ws);
  } else {
    const already = waitingPool.findIndex(u => u.userId === userId);
    if (already === -1) waitingPool.push({ userId, tags, ws });
    send(ws, { type: 'waiting' });
  }
}

function endSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const { peerId, peerWs } = session;
  send(peerWs, { type: 'peer_left', peerId: userId });
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

    if (msg.type === 'reconnect_request') {
      const targetId = msg.peerId;
      const peerEntry = reconnectPool.get(targetId);

      if (peerEntry && peerEntry.peerId === userId) {
        // Both sides want to reconnect!
        clearTimeout(peerEntry.timer);
        reconnectPool.delete(targetId);
        reconnectPool.delete(userId);
        const peerWs = connections.get(targetId);
        if (peerWs) createSession(userId, ws, targetId, peerWs);
      } else {
        // Wait up to 30s for the other person to also click reconnect
        const timer = setTimeout(() => {
          reconnectPool.delete(userId);
          send(ws, { type: 'reconnect_expired' });
        }, 30000);
        reconnectPool.set(userId, { peerId: targetId, timer });
        send(ws, { type: 'reconnect_waiting' });
      }
    }
  });

  ws.on('close', () => {
    if (!userId) return;
    connections.delete(userId);
    removeFromQueue(userId);
    endSession(userId);
    const entry = reconnectPool.get(userId);
    if (entry) { clearTimeout(entry.timer); reconnectPool.delete(userId); }
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', waiting: waitingPool.length, active: activeSessions.size / 2 }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Luma backend running on port ${PORT}`));
