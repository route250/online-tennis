// WebSocket 対応クライアント（ロビー + ゲーム）
// サーブ制御・相手パドル描画を追加

(() => {
  const $ = id => document.getElementById(id);

  // UI 要素
  const usernameInput = $('username');
  const enterBtn = $('enterLobby');
  const meLabel = $('me');
  const participantsList = $('participants');
  const logs = $('logs');
  const lobby = $('lobby');
  const gameScreen = $('game');
  const gameCanvas = $('gameCanvas');
  const leaveBtn = $('leaveGame');
  // Scoreboard DOM
  const scoreTopName = $('scoreTopName');
  const scoreTopVal = $('scoreTopVal');
  const scoreBotName = $('scoreBotName');
  const scoreBotVal = $('scoreBotVal');
  const serveTop = $('serveTop');
  const serveBot = $('serveBot');

  // State
  let ws = null;
  let myId = null;
  let username = null;
  let participants = {}; // id -> { id, name, lastSeen }
  let currentRoom = null; // { roomId, players }
  let serveId = null;
  let servePending = false; // waiting for serve click
  let lastSentX = null;

  // ゲーム状態（サーバ由来・ローカル補完）
  const gameState = {
    paddles: {}, // id -> { x,y,w,h }
    ball: { x: 400, y: 200, vx: 0, vy: 0, r: 8 },
    running: false,
    width: gameCanvas.width,
    height: gameCanvas.height,
    scores: {}
  };

  // WebSocket URL （同一オリジンの /ws を使う）
  const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';

  // simple logger used by client UI (append to #logs and console)
  function log(msg) {
    try {
      if (logs) {
        const el = document.createElement('div');
        el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logs.appendChild(el);
      }
    } catch (e) {
      // ignore logging errors
    }
    try { console.log(msg); } catch (e) {}
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      log(`WebSocket 接続確立: ${WS_URL}`);
      safeSend({ type: 'CONNECT', timestamp: new Date().toISOString() });
      startHeartbeat();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      log('WebSocket 切断');
      stopHeartbeat();
      setTimeout(connectWs, 1000);
    });

    ws.addEventListener('error', (e) => {
      console.warn('WebSocket error', e);
    });
  }

  function safeSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { console.warn('send failed', e); }
  }

  function handleServerMessage(msg) {
    const type = msg.type;
    if (type === 'CONNECT_ACK') {
      const payload = msg.payload || {};
      myId = payload.id || myId;
      const list = payload.participants || [];
      participants = {};
      list.forEach(p => { participants[p.id] = { id: p.id, name: p.name || '', lastSeen: p.lastSeen }; });
      renderParticipants();
      log(`CONNECT_ACK 受信. id=${myId}`);
      return;
    }

    if (type === 'PARTICIPANTS') {
      const list = (msg.payload && msg.payload.participants) || [];
      participants = {};
      list.forEach(p => { participants[p.id] = { id: p.id, name: p.name || '', lastSeen: p.lastSeen }; });
      renderParticipants();
      updateScorePanel();
      return;
    }

    if (type === 'INVITE') {
      const from = msg.payload && msg.payload.fromId;
      const fromName = participants[from] ? participants[from].name : from;
      if (confirm(`"${fromName}" から対戦申し込みが来ました。承諾しますか？`)) {
        safeSend({ type: 'INVITE_RESPONSE', senderId: myId, payload: { targetId: from, fromId: myId, accepted: true } });
        log(`INVITE を承諾: ${fromName}`);
      } else {
        safeSend({ type: 'INVITE_RESPONSE', senderId: myId, payload: { targetId: from, fromId: myId, accepted: false } });
        log(`INVITE を拒否: ${fromName}`);
      }
      return;
    }

    if (type === 'INVITE_RESPONSE') {
      const accepted = msg.payload && msg.payload.accepted;
      log(`INVITE_RESPONSE 受信: accepted=${accepted} from=${msg.payload && msg.payload.fromId}`);
      return;
    }

    if (type === 'ROOM_CREATED') {
      const payload = msg.payload || {};
      currentRoom = { roomId: payload.roomId, players: payload.players };
      // serveId: players[0] が最初のサーブとする（サーバ設計に合わせる）
      serveId = currentRoom.players[0];
      servePending = true;
      log(`ROOM_CREATED: ${currentRoom.roomId} players=${currentRoom.players.join(',')}`);
      const serveName = participants[serveId] ? participants[serveId].name : serveId;
      log(`最初は ${serveName} のサーブです`);
      // Prepare game screen but wait for GAME_STATE from server for paddle positions
      enterGameScreen();
      updateScorePanel();
      return;
    }

    if (type === 'START_GAME') {
      log('START_GAME 受信');
      // server may start simulation paused; await GAME_STATE for positions
      return;
    }

    if (type === 'GAME_STATE') {
      const s = msg.payload;
      if (!s) return;
      // Update authoritative state
      if (s.paddles) {
        gameState.paddles = Object.assign({}, s.paddles);
      }
      if (s.ball) {
        gameState.ball = Object.assign({}, s.ball);
      }
      if (s.scores) {
        gameState.scores = Object.assign({}, s.scores);
      }
      gameState.running = !!s.running;
      if (s.serveId) {
        serveId = s.serveId;
      }
      updateScorePanel();

      // If game not running and we have a room, keep serve pending (show message)
      if (!gameState.running && currentRoom) {
        servePending = true;
        // ensure ball is positioned near serve paddle (server should already set)
      } else {
        servePending = false;
      }

      return;
    }

    if (type === 'ROOM_ENDED') {
      const winnerId = msg.payload && msg.payload.winner;
      const winnerName = winnerId && participants[winnerId] ? participants[winnerId].name : (winnerId || '不明');
      log(`対戦終了（ROOM_ENDED） 勝者: ${winnerName}`);
      try { if (winnerId) alert(`対戦終了！勝者: ${winnerName}`); } catch (e) {}
      currentRoom = null;
      serveId = null;
      servePending = false;
      exitGameScreen();
      updateScorePanel();
      return;
    }
  }

  // Heartbeat
  let hbInterval = null;
  function startHeartbeat() {
    if (hbInterval) return;
    hbInterval = setInterval(() => {
      safeSend({ type: 'HEARTBEAT', senderId: myId, timestamp: new Date().toISOString() });
    }, 5000);
  }
  function stopHeartbeat() {
    if (!hbInterval) return;
    clearInterval(hbInterval);
    hbInterval = null;
  }

  // Participants render
  function renderParticipants() {
    participantsList.innerHTML = '';
    Object.values(participants).forEach(p => {
      if (p.id === myId) return;
      const li = document.createElement('li');
      li.className = 'participant';
      li.innerHTML = `<span>${p.name || p.id}</span>`;
      const btn = document.createElement('button');
      btn.textContent = '対戦申し込み';
      btn.addEventListener('click', () => {
        inviteParticipant(p);
      });
      li.appendChild(btn);
      participantsList.appendChild(li);
    });
  }

  function inviteParticipant(p) {
    if (!myId) { alert('未接続です'); return; }
    log(`"${p.name}" に対戦申し込みを送信`);
    safeSend({ type: 'INVITE', senderId: myId, payload: { targetId: p.id, fromId: myId } });
  }

  // ロビー操作
  enterBtn.addEventListener('click', () => {
    if (!usernameInput.value.trim()) {
      alert('ユーザ名を入力してください');
      return;
    }
    username = usernameInput.value.trim();
    meLabel.textContent = `あなた: ${username}`;
    log(`ロビーに入室しました（${username}）`);
    connectWs();
    // JOIN_LOBBY を送る（name を登録）— 少し遅らせて id を受け取ってから
    setTimeout(() => {
      safeSend({ type: 'JOIN_LOBBY', senderId: myId, payload: { name: username } });
    }, 300);
  });

  // ゲーム画面制御
  function enterGameScreen() {
    lobby.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    // keep running=false until serve
    gameState.running = false;
  }

  function exitGameScreen() {
    gameState.running = false;
    gameScreen.classList.add('hidden');
    lobby.classList.remove('hidden');
    log('ロビーに戻りました');
  }

  leaveBtn.addEventListener('click', () => {
    if (currentRoom) {
      safeSend({ type: 'DISCONNECT', senderId: myId, payload: { roomId: currentRoom.roomId } });
      currentRoom = null;
    }
    exitGameScreen();
  });

  // Rendering (canvas)
  const ctx = gameCanvas.getContext('2d');
  // Helper: whether to mirror vertically (so my paddle appears at bottom)
  function isMirroredView() {
    return currentRoom && Array.isArray(currentRoom.players) && myId && currentRoom.players[1] === myId;
  }
  function renderYForBall(y) {
    return isMirroredView() ? (gameCanvas.height - y) : y;
  }
  function renderYForPaddle(p) {
    if (!p) return 0;
    return isMirroredView() ? (gameCanvas.height - p.y - p.h) : p.y;
  }
  function draw() {
    ctx.clearRect(0,0,gameCanvas.width, gameCanvas.height);
    // 背景
    ctx.fillStyle = '#0a5f36';
    ctx.fillRect(0,0,gameCanvas.width, gameCanvas.height);
    drawCourt();

    // Draw paddles (server-sent) or local fallback
    const paddles = gameState.paddles && Object.keys(gameState.paddles).length ? gameState.paddles : { self: gameState.paddle };
    for (const pid in paddles) {
      const p = paddles[pid];
      if (!p) continue;
      ctx.fillStyle = pid === myId ? '#ffffff' : '#ffdd57';
      const drawY = renderYForPaddle(p);
      ctx.fillRect(p.x, drawY, p.w, p.h);
    }

    // Ball
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gameState.ball.x, renderYForBall(gameState.ball.y), gameState.ball.r, 0, Math.PI*2);
    ctx.fill();

    // Overlay: serve message if pending
    if (servePending && currentRoom) {
      const serveName = participants[serveId] ? participants[serveId].name : serveId;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(10, 10, 300, 36);
      ctx.fillStyle = '#fff';
      ctx.font = '16px sans-serif';
      ctx.fillText(`最初は ${serveName} のサーブです。サーブ側はクリックで開始。`, 16, 34);
    }

    // Scoreboard is drawn in DOM (outside canvas)
  }

  // Tennis court styling (visual only)
  function drawCourt() {
    const w = gameCanvas.width;
    const h = gameCanvas.height;
    ctx.save();
    // outer border
    ctx.strokeStyle = '#e7f0e7';
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, w - 12, h - 12);

    // service boxes (simple approximation)
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e7f0e7';
    // net (center horizontal dashed line)
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(12, h / 2);
    ctx.lineTo(w - 12, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // center service line (vertical)
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2 - 140);
    ctx.lineTo(w / 2, h / 2 + 140);
    ctx.stroke();

    // service lines (top and bottom, approximate positions)
    const boxOffset = 140;
    ctx.beginPath();
    ctx.moveTo(12, h / 2 - boxOffset);
    ctx.lineTo(w - 12, h / 2 - boxOffset);
    ctx.moveTo(12, h / 2 + boxOffset);
    ctx.lineTo(w - 12, h / 2 + boxOffset);
    ctx.stroke();

    // singles sidelines (inner rectangle)
    ctx.beginPath();
    ctx.rect(30, 12, w - 60, h - 24);
    ctx.stroke();

    ctx.restore();
  }

  // Update scoreboard panel in DOM
  function updateScorePanel() {
    if (!currentRoom) {
      scoreTopName.textContent = 'Opponent';
      scoreBotName.textContent = 'You';
      scoreTopVal.textContent = '0';
      scoreBotVal.textContent = '0';
      serveTop.classList.remove('active');
      serveBot.classList.remove('active');
      return;
    }

    // Determine top/bottom ids from room players and mirror setting
    const p0 = currentRoom.players[0];
    const p1 = currentRoom.players[1];
    const my = myId;
    const opp = (p0 === my) ? p1 : p0;

    const topId = opp || p0;
    const bottomId = my || p1;
    const topName = (participants[topId] && participants[topId].name) ? participants[topId].name : (topId || '');
    const bottomName = (participants[bottomId] && participants[bottomId].name) ? participants[bottomId].name : (bottomId || '');
    const sTop = (gameState.scores && topId && (topId in gameState.scores)) ? gameState.scores[topId] : 0;
    const sBot = (gameState.scores && bottomId && (bottomId in gameState.scores)) ? gameState.scores[bottomId] : 0;

    if (scoreTopName) scoreTopName.textContent = topName;
    if (scoreBotName) scoreBotName.textContent = bottomName;
    if (scoreTopVal) scoreTopVal.textContent = String(sTop);
    if (scoreBotVal) scoreBotVal.textContent = String(sBot);

    if (serveTop && serveBot) {
      if (serveId === topId) {
        serveTop.classList.add('active');
        serveBot.classList.remove('active');
      } else if (serveId === bottomId) {
        serveTop.classList.remove('active');
        serveBot.classList.add('active');
      } else {
        serveTop.classList.remove('active');
        serveBot.classList.remove('active');
      }
    }
  }

  function gameLoop() {
    // local prediction if gameState.running is false -> ball stays; if running and server-driven, server GAME_STATE will update ball
    draw();
    requestAnimationFrame(gameLoop);
  }

  // Paddle control (mouse drag) — update local copy and send INPUT when in room
  let dragging = false;
  let dragOffsetX = 0;
  function getCanvasX(e) {
    const rect = gameCanvas.getBoundingClientRect();
    return ('clientX' in e) ? (e.clientX - rect.left) : (e.touches[0].clientX - rect.left);
  }
  function getCanvasY(e) {
    const rect = gameCanvas.getBoundingClientRect();
    return ('clientY' in e) ? (e.clientY - rect.top) : (e.touches[0].clientY - rect.top);
  }

  gameCanvas.addEventListener('mousedown', (e) => {
    const x = getCanvasX(e);
    const y = getCanvasY(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle || { x: (gameCanvas.width-100)/2, w:100, y: gameCanvas.height-40, h: 12 };
    const drawY = renderYForPaddle(p);
    if (x >= p.x && x <= p.x + p.w && y >= drawY && y <= drawY + (p.h || 12)) {
      dragging = true;
      dragOffsetX = x - p.x;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = getCanvasX(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle;
    if (!p) return;
    const newX = Math.max(0, Math.min(gameCanvas.width - p.w, x - dragOffsetX));
    // local immediate reflect
    if (!gameState.paddles) gameState.paddles = {};
    gameState.paddles[myId] = Object.assign({}, p, { x: newX });
    // send INPUT if in room
    if (currentRoom && myId) {
      const now = Date.now();
      const sendX = Math.round(newX);
      if (lastSentX === null || Math.abs(sendX - lastSentX) > 2) {
        safeSend({ type: 'INPUT', senderId: myId, payload: { roomId: currentRoom.roomId, action: 'PADDLE_MOVE', x: sendX, ts: now } });
        lastSentX = sendX;
      }
    }
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  // Touch
  gameCanvas.addEventListener('touchstart', (e) => {
    const x = getCanvasX(e);
    const y = getCanvasY(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle || { x: (gameCanvas.width-100)/2, w:100, y: gameCanvas.height-40, h: 12 };
    const drawY = renderYForPaddle(p);
    if (x >= p.x && x <= p.x + p.w && y >= drawY && y <= drawY + (p.h || 12)) {
      dragging = true;
      dragOffsetX = x - (p ? p.x : 0);
    }
    e.preventDefault();
  }, { passive: false });

  gameCanvas.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const x = getCanvasX(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle;
    if (!p) return;
    const newX = Math.max(0, Math.min(gameCanvas.width - p.w, x - dragOffsetX));
    gameState.paddles[myId] = Object.assign({}, p, { x: newX });
    if (currentRoom && myId) {
      const now = Date.now();
      const sendX = Math.round(newX);
      if (lastSentX === null || Math.abs(sendX - lastSentX) > 2) {
        safeSend({ type: 'INPUT', senderId: myId, payload: { roomId: currentRoom.roomId, action: 'PADDLE_MOVE', x: sendX, ts: now } });
        lastSentX = sendX;
      }
    }
    e.preventDefault();
  }, { passive: false });

  // Serve on click: if servePending and I'm the server, send SERVE
  gameCanvas.addEventListener('click', (e) => {
    if (!servePending || !currentRoom) return;
    if (myId !== serveId) return; // only server can serve
    log('サーブを実行（クリック検出）');
    safeSend({ type: 'SERVE', senderId: myId, payload: { roomId: currentRoom.roomId, fromId: myId } });
    // optimistic local flag; server will start running and broadcast GAME_STATE
    servePending = false;
  });

  // Initialization
  requestAnimationFrame(gameLoop);

  // Debug API
  window.__debug = {
    connectWs,
    safeSend,
    getState: () => ({ myId, username, participants, currentRoom, serveId, servePending, gameState })
  };
})();

