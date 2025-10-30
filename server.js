// server.js - TalkTalk (serves public/, simulated OTP, WebSocket + signalling)
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// In-memory
const users = {}; // mobile -> { mobile, name, avatar, verified, contacts:Set, ws }
const messages = []; // { from, to, kind, text?, audio?, image?, time }
const otps = {}; // mobile -> { code, expires }

function genOtp() { return Math.floor(100000 + Math.random() * 900000).toString(); }

// Serve index at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Simulated OTP
app.post('/request-otp', (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.status(400).json({ error: 'mobile required' });
  const code = genOtp();
  otps[mobile] = { code, expires: Date.now() + 5 * 60 * 1000 };
  // Simulate by logging to console (no SMS)
  console.log(`\n[SIMULATED OTP] ${mobile} -> ${code}\n`);
  return res.json({ ok: true, message: 'OTP generated (check server console)' });
});

app.post('/verify-otp', (req, res) => {
  const { mobile, code, name, avatar } = req.body;
  if (!mobile || !code) return res.status(400).json({ error: 'mobile and code required' });
  const rec = otps[mobile];
  if (!rec) return res.status(400).json({ error: 'no OTP requested' });
  if (Date.now() > rec.expires) return res.status(400).json({ error: 'OTP expired' });
  if (rec.code !== code) return res.status(400).json({ error: 'invalid OTP' });
  delete otps[mobile];
  if (!users[mobile]) {
    users[mobile] = { mobile, name: name || mobile, avatar: avatar || null, verified: true, contacts: new Set(), ws: null };
  } else {
    users[mobile].verified = true;
    users[mobile].name = name || users[mobile].name;
    if (avatar) users[mobile].avatar = avatar;
  }
  broadcastUsers();
  return res.json({ ok: true, user: { mobile: users[mobile].mobile, name: users[mobile].name, avatar: users[mobile].avatar } });
});

// list users
app.get('/users', (req, res) => {
  const list = Object.values(users).map(u => ({
    mobile: u.mobile, name: u.name, avatar: u.avatar, verified: !!u.verified, contacts: Array.from(u.contacts || [])
  }));
  res.json(list);
});

// history between two mobiles
app.get('/history/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const convo = messages.filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a));
  res.json(convo);
});

function broadcastUsers() {
  const payload = JSON.stringify({
    type: 'users_list',
    users: Object.values(users).map(u => ({ mobile: u.mobile, name: u.name, avatar: u.avatar, verified: !!u.verified, contacts: Array.from(u.contacts || []) }))
  });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

// WebSocket handlers (messaging + signalling)
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'auth': {
        const mobile = msg.mobile;
        if (!mobile) return;
        if (!users[mobile] || !users[mobile].verified) {
          ws.send(JSON.stringify({ type: 'error', error: 'not verified' }));
          return;
        }
        users[mobile].ws = ws;
        ws.mobile = mobile;
        ws.send(JSON.stringify({ type: 'auth_ok', user: users[mobile] }));
        broadcastUsers();
        break;
      }

      case 'add_contact': {
        const { from, to } = msg;
        if (!users[from] || !users[to]) return;
        users[from].contacts.add(to);
        broadcastUsers();
        break;
      }

      case 'message': {
        // message: { type:'message', from, to, kind, text?, audio?, image? }
        const now = Date.now();
        const stored = { ...msg, time: now };
        messages.push(stored);
        const rec = users[msg.to];
        if (rec && rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.send(JSON.stringify(stored));
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...stored, self: true }));
        break;
      }

      // WebRTC signalling
      case 'webrtc-offer': {
        const { from, to, sdp } = msg;
        if (users[to] && users[to].ws && users[to].ws.readyState === WebSocket.OPEN) {
          users[to].ws.send(JSON.stringify({ type: 'webrtc-offer', from, sdp }));
        }
        break;
      }
      case 'webrtc-answer': {
        const { from, to, sdp } = msg;
        if (users[to] && users[to].ws && users[to].ws.readyState === WebSocket.OPEN) {
          users[to].ws.send(JSON.stringify({ type: 'webrtc-answer', from, sdp }));
        }
        break;
      }
      case 'webrtc-ice': {
        const { from, to, candidate } = msg;
        if (users[to] && users[to].ws && users[to].ws.readyState === WebSocket.OPEN) {
          users[to].ws.send(JSON.stringify({ type: 'webrtc-ice', from, candidate }));
        }
        break;
      }

      case 'update_profile': {
        const { mobile, name, avatar } = msg;
        if (!users[mobile]) return;
        users[mobile].name = name || users[mobile].name;
        if (avatar) users[mobile].avatar = avatar;
        broadcastUsers();
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    if (ws.mobile && users[ws.mobile]) users[ws.mobile].ws = null;
    broadcastUsers();
  });
});

// ping/pong to close dead sockets
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`TalkTalk server → http://localhost:${PORT}`));
