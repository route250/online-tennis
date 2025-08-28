// Minimal server: Express + ws (WebSocket)
// Usage: `node server/index.js`
// Serves static files from project root and exposes WS at /ws

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
let QRCode;
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.HOST || '0.0.0.0';

function detectLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}

function computeServerURLs() {
  const publicHost = (BIND_HOST === '0.0.0.0' || BIND_HOST === '::') ? detectLanIPv4() : BIND_HOST;
  const bindHost = BIND_HOST;
  const httpURL = `http://${bindHost}:${PORT}`;
  const httpURLPublic = `http://${publicHost}:${PORT}`;
  const wsURL = `ws://${bindHost}:${PORT}/ws`;
  const wsURLPublic = `ws://${publicHost}:${PORT}/ws`;
  return { bindHost, publicHost, port: PORT, httpURL, httpURLPublic, wsURL, wsURLPublic };
}

const app = express();
// Serve client assets from /client
app.use(express.static(path.join(__dirname, '..', 'client')));

// Expose server info for client to render QR and URL
app.get('/server-info', (req, res) => {
  res.json(computeServerURLs());
});

// Generate QR as SVG for the given URL (or default to httpURLPublic)
app.get('/qr.svg', async (req, res) => {
  const { httpURLPublic } = computeServerURLs();
  const target = (req.query && req.query.url) ? String(req.query.url) : httpURLPublic;
  try {
    if (!QRCode) throw new Error('qrcode module not installed');
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, scale: 4, color: { dark: '#ffffff', light: '#00000000' } });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    // Fallback: simple SVG with text
    const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const text = esc(target);
    const fallback = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="100%" height="100%" fill="#111"/><text x="90" y="90" fill="#fff" font-size="12" text-anchor="middle" dominant-baseline="middle">QR unavailable</text><text x="90" y="160" fill="#aaa" font-size="10" text-anchor="middle">${text}</text></svg>`;
    res.type('image/svg+xml').send(fallback);
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// In-memory state
const participants = new Map(); // id -> { id, name, ws, lastSeen }
const rooms = new Map(); // roomId -> { id, players: [id,...], status }

function makeId(prefix = '') {
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
}

function nowTs() { return new Date().toISOString(); }

// ---- Server-side game loop helpers ----
// Each room will hold a gameState and a gameInterval to run authoritative simulation.
// gameState: { ball: {x,y,vx,vy,r}, paddles: { playerId: {x,y,w,h} }, scores: { playerId: n }, running: bool }
function startRoomGame(room) {
  if (!room) return;
  if (room.gameInterval) return; // already running

  // initialize simple game state
  const width = 500;
  const height = 700;
  const paddleW = 80;
  const paddleH = 12;
  const players = room.players.slice();

  const paddles = {};
  // place player0 at bottom, player1 at top
  paddles[players[0]] = { x: (width - paddleW) / 2, y: height - 40, w: paddleW, h: paddleH };
  paddles[players[1]] = { x: (width - paddleW) / 2, y: 28, w: paddleW, h: paddleH };

  // If a pre-existing gameState exists (e.g., pre-serve), reuse paddles/scores
  let gameState = room.gameState;
  if (!gameState) {
    gameState = {
      ball: { x: width / 2, y: height / 2, vx: 0, vy: 0, r: 8 },
      paddles,
      scores: { [players[0]]: 0, [players[1]]: 0 },
      running: false,
      width,
      height,
      serveId: players[0]
    };
    room.gameState = gameState;
  }
  room.status = 'running';

  // notify players that room is ready / starting
  const startMsg = { type: 'START_GAME', timestamp: nowTs(), payload: { roomId: room.id } };
  for (const pid of players) {
    const p = participants.get(pid);
    if (p) safeSend(p.ws, startMsg);
  }

  // send immediate GAME_STATE so clients render the pre-serve position right away
  const initialStateMsg = {
    type: 'GAME_STATE',
    timestamp: nowTs(),
    payload: {
      roomId: room.id,
      ball: gameState.ball,
      paddles: gameState.paddles,
      scores: gameState.scores,
      running: gameState.running,
      serveId: gameState.serveId
    }
  };
  for (const pid of players) {
    const p = participants.get(pid);
    if (p) safeSend(p.ws, initialStateMsg);
  }

  // simulation loop ~20Hz
  const BALL_SPEED_MULT = 2; // simulation scale factor (keep baseline speed)
  room.gameInterval = setInterval(() => {
    const s = room.gameState;
    if (!s || !s.running) return;

    // integrate ball
    const prevX = s.ball.x;
    const prevY = s.ball.y;
    s.ball.x += s.ball.vx * BALL_SPEED_MULT;
    s.ball.y += s.ball.vy * BALL_SPEED_MULT;

    // wall collision left/right
    if (s.ball.x - s.ball.r < 0) { s.ball.x = s.ball.r; s.ball.vx *= -1; }
    if (s.ball.x + s.ball.r > s.width) { s.ball.x = s.width - s.ball.r; s.ball.vx *= -1; }

    // top/bottom -> score
    if (s.ball.y - s.ball.r < 0) {
      // bottom player scores
      const scorer = players[0];
      s.scores[scorer] += 1;
      s.running = false;
      s.serveId = scorer;
      // check win condition immediately after scoring
      {
        const other = players[1];
        const a = s.scores[scorer] || 0;
        const b = s.scores[other] || 0;
        const max = Math.max(a, b);
        const min = Math.min(a, b);
        const lead = max - min;
        const target = 7;
        const winBy = 2;
        const hardCap = 11;
        let winnerId = null;
        if (max >= hardCap) winnerId = (a > b) ? scorer : other;
        else if (max >= target && lead >= winBy) winnerId = (a > b) ? scorer : other;
        if (winnerId) {
          room.status = 'ended';
          const endMsg = { type: 'ROOM_ENDED', timestamp: nowTs(), payload: { roomId: room.id, winner: winnerId } };
          for (const pid of players) {
            const p = participants.get(pid);
            if (p) safeSend(p.ws, endMsg);
          }
          clearInterval(room.gameInterval);
          room.gameInterval = null;
          return;
        }
      }
      // position ball near server's paddle (static)
      positionBallNearPaddle(s, scorer);
      // broadcast pre-serve state immediately
      const stateMsg = { type: 'GAME_STATE', timestamp: nowTs(), payload: {
        roomId: room.id,
        ball: s.ball,
        paddles: s.paddles,
        scores: s.scores,
        running: s.running,
        serveId: s.serveId
      }};
      for (const pid of players) {
        const p = participants.get(pid);
        if (p) safeSend(p.ws, stateMsg);
      }
      return; // skip further processing this tick
    } else if (s.ball.y + s.ball.r > s.height) {
      // top player scores
      const scorer = players[1];
      s.scores[scorer] += 1;
      s.running = false;
      s.serveId = scorer;
      // check win condition immediately after scoring
      {
        const other = players[0];
        const a = s.scores[scorer] || 0;
        const b = s.scores[other] || 0;
        const max = Math.max(a, b);
        const min = Math.min(a, b);
        const lead = max - min;
        const target = 7;
        const winBy = 2;
        const hardCap = 11;
        let winnerId = null;
        if (max >= hardCap) winnerId = (a > b) ? scorer : other;
        else if (max >= target && lead >= winBy) winnerId = (a > b) ? scorer : other;
        if (winnerId) {
          room.status = 'ended';
          const endMsg = { type: 'ROOM_ENDED', timestamp: nowTs(), payload: { roomId: room.id, winner: winnerId } };
          for (const pid of players) {
            const p = participants.get(pid);
            if (p) safeSend(p.ws, endMsg);
          }
          clearInterval(room.gameInterval);
          room.gameInterval = null;
          return;
        }
      }
      positionBallNearPaddle(s, scorer);
      const stateMsg = { type: 'GAME_STATE', timestamp: nowTs(), payload: {
        roomId: room.id,
        ball: s.ball,
        paddles: s.paddles,
        scores: s.scores,
        running: s.running,
        serveId: s.serveId
      }};
      for (const pid of players) {
        const p = participants.get(pid);
        if (p) safeSend(p.ws, stateMsg);
      }
      return;
    }

    // paddle collisions (consider ball radius and travel direction + swept test)
    for (const pid of players) {
      const p = s.paddles[pid];
      if (!p) continue;

      // Horizontal overlap including ball radius (check current or previous)
      const hitsXNow = (s.ball.x + s.ball.r >= p.x) && (s.ball.x - s.ball.r <= p.x + p.w);
      const hitsXPrev = (prevX + s.ball.r >= p.x) && (prevX - s.ball.r <= p.x + p.w);
      const hitsX = hitsXNow || hitsXPrev;
      if (!hitsX) continue;

      const isTopPaddle = p.y < s.height / 2;

      if (isTopPaddle) {
        // Ball moving upward and reaching the bottom edge of top paddle
        const crossed = (s.ball.vy < 0) && (prevY - s.ball.r >= p.y + p.h) && (s.ball.y - s.ball.r <= p.y + p.h);
        const overlappingNow = (s.ball.y + s.ball.r >= p.y) && (s.ball.y - s.ball.r <= p.y + p.h);
        if ((s.ball.vy < 0) && (crossed || overlappingNow)) {
          // incorporate paddle swing and contact offset
          const pV = p._vx || 0; // px per tick
          const offset = (s.ball.x - (p.x + p.w / 2)) / (p.w / 2);
          s.ball.vx += offset * 0.6 + pV * 0.7;
          // increase vertical speed depending on paddle swing
          const baseVy = Math.abs(s.ball.vy);
          const speedUp = Math.min(6, Math.abs(pV) * 0.45);
          const newVy = Math.min(12, Math.max(2.5, baseVy + speedUp));
          s.ball.vy = newVy; // top paddle -> ball goes down
          // clamp horizontal speed
          s.ball.vx = Math.max(-10, Math.min(10, s.ball.vx));
          // push ball out to avoid re-colliding next tick
          s.ball.y = p.y + p.h + s.ball.r + 1;
        }
      } else {
        // bottom paddle: ball moving downward and reaching top edge of bottom paddle
        const crossed = (s.ball.vy > 0) && (prevY + s.ball.r <= p.y) && (s.ball.y + s.ball.r >= p.y);
        const overlappingNow = (s.ball.y + s.ball.r >= p.y) && (s.ball.y - s.ball.r <= p.y + p.h);
        if ((s.ball.vy > 0) && (crossed || overlappingNow)) {
          const pV = p._vx || 0;
          const offset = (s.ball.x - (p.x + p.w / 2)) / (p.w / 2);
          s.ball.vx += offset * 0.6 + pV * 0.7;
          const baseVy = Math.abs(s.ball.vy);
          const speedUp = Math.min(6, Math.abs(pV) * 0.45);
          const newVy = Math.min(12, Math.max(2.5, baseVy + speedUp));
          s.ball.vy = -newVy; // bottom paddle -> ball goes up
          s.ball.vx = Math.max(-10, Math.min(10, s.ball.vx));
          s.ball.y = p.y - s.ball.r - 1;
        }
      }
    }

    // Win condition check (redundant guard while running)
    // Note: primary win check happens on scoring; this is a safety check.
    const target = 7; // win target
    const winBy = 2;  // lead by 2
    const hardCap = 11; // hard cap to avoid endless deuce
    const a = s.scores[players[0]] || 0;
    const b = s.scores[players[1]] || 0;
    const max = Math.max(a, b);
    const min = Math.min(a, b);
    const lead = max - min;
    let winnerId = null;
    if (max >= hardCap) {
      winnerId = (a > b) ? players[0] : players[1];
    } else if (max >= target && lead >= winBy) {
      winnerId = (a > b) ? players[0] : players[1];
    }
    if (winnerId) {
      s.running = false;
      room.status = 'ended';
      const endMsg = { type: 'ROOM_ENDED', timestamp: nowTs(), payload: { roomId: room.id, winner: winnerId } };
      for (const q of players) {
        const pp = participants.get(q);
        if (pp) safeSend(pp.ws, endMsg);
      }
      clearInterval(room.gameInterval);
      room.gameInterval = null;
      return;
    }

    // broadcast GAME_STATE to players
    const stateMsg = {
      type: 'GAME_STATE',
      timestamp: nowTs(),
      payload: {
        roomId: room.id,
        ball: { x: s.ball.x, y: s.ball.y, vx: s.ball.vx, vy: s.ball.vy, r: s.ball.r },
        paddles: s.paddles,
        scores: s.scores,
        running: s.running,
        serveId: s.serveId
      }
    };
    for (const pid of players) {
      const p = participants.get(pid);
      if (p) safeSend(p.ws, stateMsg);
    }
  }, 50); // 20Hz
}

function resetBall(s, direction = 1) {
  // direction: 1 -> towards top? we set a small vy accordingly (positive vy goes down)
  s.ball.x = s.width / 2;
  s.ball.y = s.height / 2;
  s.ball.vx = 0;
  s.ball.vy = 0;
}

function positionBallNearPaddle(s, serverId) {
  const p = s.paddles[serverId];
  if (!p) return;
  s.ball.x = p.x + p.w / 2;
  // place just in front of paddle in world coordinates
  if (p.y < s.height / 2) {
    // top paddle: place below it
    s.ball.y = p.y + p.h + s.ball.r + 2;
  } else {
    // bottom paddle: place above it
    s.ball.y = p.y - s.ball.r - 2;
  }
  s.ball.vx = 0;
  s.ball.vy = 0;
}

function launchServe(s, serverId) {
  // set initial velocity influenced by paddle swing
  const p = s.paddles[serverId];
  if (!p) return;
  const pV = p._vx || 0; // px per tick
  const dirDown = (p.y < s.height / 2); // top paddle serves downward
  const baseVy = 3 + Math.min(8, Math.abs(pV)) * 0.5; // stronger boost by swing
  let vx = pV * 0.8 + (Math.random() - 0.5) * 0.6; // small randomness
  vx = Math.max(-6, Math.min(6, vx));
  const vy = dirDown ? baseVy : -baseVy;
  s.ball.vx = vx;
  s.ball.vy = vy;
  s.running = true;
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.warn('send failed', e);
  }
}

function broadcastParticipants() {
  const list = Array.from(participants.values()).map(p => ({
    id: p.id,
    name: p.name,
    lastSeen: p.lastSeen
  }));
  const msg = { type: 'PARTICIPANTS', timestamp: nowTs(), payload: { participants: list } };
  for (const p of participants.values()) {
    safeSend(p.ws, msg);
  }
}

wss.on('connection', (ws, req) => {
  const id = makeId('p-');
  participants.set(id, { id, name: '', ws, lastSeen: Date.now() });
  console.log(`WS connected: ${id} (${req.socket.remoteAddress})`);

  // Send CONNECT_ACK with assigned id and current participants
  const initialList = Array.from(participants.values()).map(p => ({ id: p.id, name: p.name, lastSeen: p.lastSeen }));
  safeSend(ws, { type: 'CONNECT_ACK', timestamp: nowTs(), payload: { id, participants: initialList } });

  broadcastParticipants();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const type = msg.type;
    const senderId = msg.senderId || id;

    if (type === 'CONNECT' || type === 'JOIN_LOBBY') {
      const name = (msg.payload && msg.payload.name) || (`user-${id}`);
      const p = participants.get(id);
      if (p) { p.name = name; p.lastSeen = Date.now(); }
      broadcastParticipants();
      console.log(`Joined: ${id} -> ${name}`);
      return;
    }

    if (type === 'HEARTBEAT') {
      const p = participants.get(id);
      if (p) p.lastSeen = Date.now();
      return;
    }

    if (type === 'INVITE') {
      // forward to target
      const targetId = msg.payload && msg.payload.targetId;
      if (!targetId) return;
      const target = participants.get(targetId);
      if (target) {
        safeSend(target.ws, Object.assign({}, msg, { timestamp: nowTs() }));
        console.log(`INVITE from ${id} -> ${targetId}`);
      }
      return;
    }

    if (type === 'INVITE_RESPONSE') {
      // forward to original inviter
      const targetId = msg.payload && msg.payload.targetId;
      if (!targetId) return;
      const target = participants.get(targetId);
      if (target) {
        safeSend(target.ws, Object.assign({}, msg, { timestamp: nowTs() }));
        console.log(`INVITE_RESPONSE from ${id} -> ${targetId} accepted=${msg.payload && msg.payload.accepted}`);
        // If accepted, create room
        if (msg.payload && msg.payload.accepted) {
          const roomId = makeId('r-');
          const players = [targetId, id];
          // create room in "waiting" state and set initial (pre-serve) gameState
          const width = 500;
          const height = 700;
          const paddleW = 80;
          const paddleH = 12;
          const paddles = {};
          // place player0 at bottom, player1 at top
          paddles[players[0]] = { x: (width - paddleW) / 2, y: height - 40, w: paddleW, h: paddleH };
          paddles[players[1]] = { x: (width - paddleW) / 2, y: 28, w: paddleW, h: paddleH };
          const gameState = {
            ball: {
              // position ball near the serving player's paddle (player0 by convention)
              x: paddles[players[0]].x + paddles[players[0]].w / 2,
              y: paddles[players[0]].y - 12,
              vx: 0, vy: 0, r: 8
            },
            paddles,
            scores: { [players[0]]: 0, [players[1]]: 0 },
            running: false,
            serveId: players[0],
            width,
            height
          };
          const roomObj = { id: roomId, players, status: 'waiting', gameState: gameState, gameInterval: null };
          rooms.set(roomId, roomObj);
          // notify both about room creation
          const roomMsg = { type: 'ROOM_CREATED', timestamp: nowTs(), payload: { roomId, players } };
          safeSend(target.ws, roomMsg);
          safeSend(ws, roomMsg);
          // send initial GAME_STATE (not running) so clients can display serve prompt and ball at server paddle
          const stateMsg = { type: 'GAME_STATE', timestamp: nowTs(), payload: Object.assign({ roomId }, gameState) };
          for (const pid of players) {
            const p = participants.get(pid);
            if (p) safeSend(p.ws, stateMsg);
          }
          console.log(`Room created ${roomId} for ${players.join(',')} (pre-serve state sent)`);
        }
      }
      return;
    }

    if (type === 'INPUT') {
      // Relay INPUT and also apply to authoritative state when relevant
      const roomId = msg.payload && msg.payload.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const action = msg.payload && msg.payload.action;
      if (action === 'PADDLE_MOVE' && room.gameState && room.gameState.paddles && room.gameState.paddles[id]) {
        const newX = msg.payload && msg.payload.x;
        const ts = (msg.payload && msg.payload.ts) || Date.now();
        const s = room.gameState;
        const p = s.paddles[id];
        if (typeof newX === 'number' && isFinite(newX)) {
          // estimate paddle horizontal velocity in px per simulation tick (~50ms)
          const prevX = (typeof p._lastX === 'number') ? p._lastX : newX;
          const prevTs = (typeof p._lastTs === 'number') ? p._lastTs : ts - 50;
          const dtMs = Math.max(1, ts - prevTs);
          const dx = newX - prevX;
          const vxTick = dx / (dtMs / 50);
          p._vx = isFinite(vxTick) ? vxTick : 0;
          p._lastTs = ts;
          p._lastX = newX;
          p.x = Math.max(0, Math.min(s.width - p.w, Math.round(newX)));
        }
        // If pre-serve (paused) and mover is the server, keep the ball attached to paddle
        if (!s.running && s.serveId === id) {
          positionBallNearPaddle(s, id);
        }
        // If pre-serve, broadcast updated authoritative state immediately so both clients stay in sync
        if (!s.running) {
          const stateMsg = { type: 'GAME_STATE', timestamp: nowTs(), payload: {
            roomId: room.id,
            ball: s.ball,
            paddles: s.paddles,
            scores: s.scores,
            running: s.running,
            serveId: s.serveId
          }};
          for (const pid of room.players) {
            const client = participants.get(pid);
            if (client) safeSend(client.ws, stateMsg);
          }
        }
      }

      // Broadcast to other players (kept for immediate peer feedback)
      for (const pid of room.players) {
        if (pid === id) continue;
        const p = participants.get(pid);
        if (p) safeSend(p.ws, Object.assign({}, msg, { timestamp: nowTs() }));
      }
      return;
    }

    if (type === 'SERVE') {
      // Start the server-side game loop for the room when the serving player triggers serve
      const roomId = msg.payload && msg.payload.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      // Only a player of the room may start the serve
      if (!room.players.includes(id)) return;
      // Ensure loop is running (idempotent)
      startRoomGame(room);
      // Set serve side and launch
      if (room.gameState) {
        room.gameState.serveId = id;
        // position near paddle if currently not running
        if (!room.gameState.running) positionBallNearPaddle(room.gameState, id);
        launchServe(room.gameState, id);
        // broadcast immediate GAME_STATE to reduce input-to-serve latency
        const s = room.gameState;
        const stateMsg = { type: 'GAME_STATE', timestamp: nowTs(), payload: {
          roomId: room.id,
          ball: s.ball,
          paddles: s.paddles,
          scores: s.scores,
          running: s.running,
          serveId: s.serveId
        }};
        for (const pid of room.players) {
          const p = participants.get(pid);
          if (p) safeSend(p.ws, stateMsg);
        }
      }
      console.log(`SERVE by ${id} for room ${roomId}`);
      return;
    }

    if (type === 'DISCONNECT') {
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    participants.delete(id);
    // remove from rooms
    for (const [rid, r] of rooms) {
      if (r.players.includes(id)) {
        r.status = 'ended';
        // notify others
        const endMsg = { type: 'ROOM_ENDED', timestamp: nowTs(), payload: { roomId: r.id, reason: 'player_disconnect' } };
        for (const pid of r.players) {
          const p = participants.get(pid);
          if (p) safeSend(p.ws, endMsg);
        }
        rooms.delete(rid);
      }
    }
    broadcastParticipants();
    console.log(`WS disconnected: ${id}`);
  });

  ws.on('error', (err) => {
    console.warn('ws error', err);
  });
});

// Periodic cleanup and participants broadcast
setInterval(() => {
  const cutoff = Date.now() - 15000; // 15s stale
  let changed = false;
  for (const [pid, p] of participants) {
    if (p.lastSeen < cutoff) {
      participants.delete(pid);
      changed = true;
    }
  }
  if (changed) broadcastParticipants();
}, 5000);

server.listen(PORT, BIND_HOST, () => {
  const info = computeServerURLs();
  console.log(`Server listening on ${info.httpURL} (public: ${info.httpURLPublic})`);
  console.log(`WebSocket endpoint ${info.wsURL} (public: ${info.wsURLPublic})`);
});
