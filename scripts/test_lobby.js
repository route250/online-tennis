// Lobby diagnostic script
// Usage: node scripts/test_lobby.js
// Connects to ws://localhost:3000/ws, sends CONNECT and JOIN_LOBBY, logs received messages (PARTICIPANTS / CONNECT_ACK / others)

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:3000/ws';
const TIMEOUT_MS = 8000;

function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

(async () => {
  console.log('Starting lobby diagnostic...');

  const ws = new WebSocket(WS_URL);
  let id = null;

  const timer = setTimeout(() => {
    console.error('Timed out waiting for messages.');
    ws.close();
    process.exit(2);
  }, TIMEOUT_MS);

  ws.on('open', () => {
    console.log('WS open -> sending CONNECT');
    ws.send(JSON.stringify({ type: 'CONNECT', timestamp: new Date().toISOString() }));
    // send JOIN_LOBBY with a random name after short delay
    setTimeout(() => {
      const name = 'diag-' + Math.floor(Math.random()*1000);
      console.log('Sending JOIN_LOBBY name=' + name);
      ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: { name } }));
    }, 200);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ console.log('non-json message', raw.toString()); return; }
    console.log('<<', msg.type, JSON.stringify(msg.payload || msg));
    if (msg.type === 'CONNECT_ACK') {
      id = msg.payload && msg.payload.id;
      console.log('Assigned id:', id);
    }
    if (msg.type === 'PARTICIPANTS') {
      const list = (msg.payload && msg.payload.participants) || [];
      console.log('Participants list length=', list.length);
      list.forEach(p => console.log(` - ${p.id}: ${p.name} (lastSeen:${p.lastSeen})`));
      // success if list contains our diag- prefix
      const found = list.some(p => p.name && p.name.startsWith('diag-'));
      if (found) {
        console.log('Diagnostic: our JOIN_LOBBY is reflected in PARTICIPANTS -> OK');
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      } else {
        console.log('Diagnostic: our JOIN_LOBBY not yet seen in PARTICIPANTS');
      }
    }
  });

  ws.on('close', () => {
    console.log('WS closed');
  });

  ws.on('error', (err) => {
    console.error('WS error', err);
  });
})();
