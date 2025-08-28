// Integration test (node): simulate 2 WS clients, run invite/accept/serve flow and check GAME_STATE updates.
// Usage: node scripts/test_integration.js
// Requires server running at ws://localhost:3000/ws

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:3000/ws';
const TIMEOUT = 20000;

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function run() {
  console.log('Starting integration test...');

  const a = new WebSocket(WS_URL);
  const b = new WebSocket(WS_URL);

  let aId = null, bId = null;
  let roomId = null;
  let aGotRoom = false, bGotRoom = false;
  let receivedRunningState = false;
  let lastBallPos = null;

  function setup(ws, name, onMsg) {
    ws.on('open', () => {
      console.log(`[${name}] open`);
      ws.send(JSON.stringify({ type: 'CONNECT', timestamp: new Date().toISOString() }));
      // send JOIN_LOBBY after short delay to allow CONNECT_ACK
      setTimeout(() => ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: { name } })), 200);
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      onMsg(msg);
    });
    ws.on('close', () => console.log(`[${name}] closed`));
    ws.on('error', (e) => console.error(`[${name}] error`, e));
  }

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test timed out')), TIMEOUT);

    setup(a, 'A', (msg) => {
      if (msg.type === 'CONNECT_ACK') {
        aId = msg.payload.id;
        console.log(`[A] assigned id=${aId}`);
      }
      if (msg.type === 'PARTICIPANTS') {
        // ignore
      }
      if (msg.type === 'ROOM_CREATED') {
        roomId = msg.payload.roomId;
        aGotRoom = true;
        console.log(`[A] ROOM_CREATED ${roomId}`);
        // determine serveId (server created room with players[0]=invitee)
        const serveId = msg.payload.players[0];
        console.log(`[A] serveId=${serveId}`);
      }
      if (msg.type === 'GAME_STATE') {
        // detect running true or ball movement
        const s = msg.payload;
        if (s && s.running) {
          receivedRunningState = true;
          console.log('[A] received running GAME_STATE');
          clearTimeout(timer);
          resolve();
        } else if (s && s.ball) {
          if (lastBallPos && (s.ball.x !== lastBallPos.x || s.ball.y !== lastBallPos.y)) {
            // ball moved even if running flag false (defensive)
            receivedRunningState = true;
            console.log('[A] detected ball movement');
            clearTimeout(timer);
            resolve();
          }
          lastBallPos = { x: s.ball.x, y: s.ball.y };
        }
      }
    });

    setup(b, 'B', (msg) => {
      if (msg.type === 'CONNECT_ACK') {
        bId = msg.payload.id;
        console.log(`[B] assigned id=${bId}`);
      }
      if (msg.type === 'INVITE') {
        // not expected for B in this flow
      }
      if (msg.type === 'ROOM_CREATED') {
        roomId = msg.payload.roomId;
        bGotRoom = true;
        console.log(`[B] ROOM_CREATED ${roomId}`);
      }
      if (msg.type === 'GAME_STATE') {
        // same observation as A
        const s = msg.payload;
        if (s && s.running) {
          receivedRunningState = true;
          console.log('[B] received running GAME_STATE');
          clearTimeout(timer);
          resolve();
        }
      }
    });

    // orchestrate once both ids are known
    const orchestrator = async () => {
      // wait until both assigned
      for (let i=0;i<50;i++) {
        if (aId && bId) break;
        await wait(100);
      }
      if (!aId || !bId) return reject(new Error('Failed to get client ids'));

      // A will invite B
      console.log(`[Test] A (${aId}) invites B (${bId})`);
      a.send(JSON.stringify({ type: 'INVITE', senderId: aId, payload: { targetId: bId, fromId: aId } }));

      // Wait for a short while, then B should receive INVITE and auto-accept simulated by manual response here
      await wait(300);

      // Simulate B accepting
      console.log(`[Test] B (${bId}) sends INVITE_RESPONSE accepted=true to A`);
      b.send(JSON.stringify({ type: 'INVITE_RESPONSE', senderId: bId, payload: { targetId: aId, fromId: bId, accepted: true } }));

      // Wait for ROOM_CREATED to be delivered
      for (let i=0;i<100;i++) {
        if (aGotRoom && bGotRoom) break;
        await wait(100);
      }
      if (!roomId) return reject(new Error('Room not created'));

      // Determine serveId: server sets players = [targetId, id] => players[0] == targetId == A? In our flow, target was bId, inviter aId,
      // we sent INVITE from A->B, and B accepted; server sets players = [targetId, id] where targetId was aId? Wait server code: INVITE forwarded to target, INVITE_RESPONSE forwarded to targetId (original inviter).
      // But in current server implementation, players = [targetId, id] where targetId is value from payload in INVITE_RESPONSE (targetId), and id is responder's id.
      // Given we send INVITE with targetId=bId from A, then B receives it and we responded with targetId: aId (from B payload), so server creates players = [aId, bId].
      // Therefore players[0] will be aId (invitee?), so choose serveId = players[0].
      // To be safe, we'll try to serve from both clients if needed: prefer the one that matches players[0].

      // Wait a bit to ensure clients received ROOM_CREATED and initial GAME_STATE
      await wait(200);

      // Decide who should send SERVE: we'll send SERVE from the player that is players[0].
      // Since we don't have direct ROOM_CREATED payload here, try both with short delay: send SERVE from B first, then from A if no response.
      console.log('[Test] Attempting SERVE from B');
      b.send(JSON.stringify({ type: 'SERVE', senderId: bId, payload: { roomId } }));

      // wait short time for running state
      await wait(600);

      if (receivedRunningState) return;
      console.log('[Test] Attempting SERVE from A');
      a.send(JSON.stringify({ type: 'SERVE', senderId: aId, payload: { roomId } }));

      // If still no running state, the orchestrator will wait for the main timer to expire
    };

    orchestrator().catch(reject);
  });

  try {
    await ready;
    console.log('Integration test: SUCCESS — GAME_STATE updates received');
    a.close();
    b.close();
    process.exit(0);
  } catch (err) {
    console.error('Integration test: FAILED', err);
    a.close();
    b.close();
    process.exit(2);
  }
}

run();
