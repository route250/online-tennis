// WebSocket 対応クライアント（ロビー + ゲーム）
// サーブ制御・相手パドル描画を追加

(() => {
  const $ = id => document.getElementById(id);

  // UI 要素
  const usernameInput = $('username');
  const enterBtn = $('enterLobby');
  const meLabel = $('me');
  const loginRow = document.getElementById('loginRow');
  const lobbyUserRow = document.getElementById('lobbyUserRow');
  const leaveLobbyBtn = document.getElementById('leaveLobby');
  const participantsList = $('participants');
  const logs = $('logs');
  const lobby = $('lobby');
  const gameScreen = $('game');
  const gameCanvas = $('gameCanvas');
  const leaveBtn = $('leaveGame');
  // QR elements
  const qrImage = document.getElementById('qrImage');
  const serverUrlEl = document.getElementById('serverUrl');
  const copyUrlBtn = document.getElementById('copyUrl');
  // Scoreboard DOM
  const scoreTopName = $('scoreTopName');
  const scoreTopVal = $('scoreTopVal');
  const scoreBotName = $('scoreBotName');
  const scoreBotVal = $('scoreBotVal');
  const serveTop = $('serveTop');
  const serveBot = $('serveBot');
  const scorePanelEl = document.getElementById('scorePanel');

  // State
  let ws = null;
  let intendedDisconnect = false; // true when user chose to leave lobby
  let myId = null;
  let username = null;
  let participants = {}; // id -> { id, name, lastSeen }
  let currentRoom = null; // { roomId, players }
  let serveId = null;
  let servePending = false; // waiting for serve click
  let serveMsgVisible = false; // center message visible before serve
  let lastServePaddleX = null; // track server paddle movement to hide message
  let lastRunning = null; // track running->stopped transition
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
    intendedDisconnect = false;
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
      // reconnect only if not intentionally disconnected by user
      if (!intendedDisconnect) setTimeout(connectWs, 1000);
    });

    ws.addEventListener('error', (e) => {
      console.warn('WebSocket error', e);
    });
  }

  // Fetch server info (host/port) and render QR/URL
  async function initServerInfo() {
    let info = null;
    try {
      const res = await fetch('/server-info', { cache: 'no-store' });
      if (res.ok) info = await res.json();
    } catch (e) { /* ignore */ }
    const origin = window.location.origin;
    const url = (info && info.httpURLPublic) ? info.httpURLPublic : origin;
    if (serverUrlEl) serverUrlEl.textContent = url;
    if (qrImage) { qrImage.src = `/qr.svg?url=${encodeURIComponent(url)}`; }
    if (copyUrlBtn) copyUrlBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(url); log('URLをコピーしました'); } catch (e) { log('クリップボードにコピーできませんでした'); }
    };
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
      updateLobbyHeaderUI();
      return;
    }

    if (type === 'PARTICIPANTS') {
      const list = (msg.payload && msg.payload.participants) || [];
      participants = {};
      list.forEach(p => { participants[p.id] = { id: p.id, name: p.name || '', lastSeen: p.lastSeen }; });
      renderParticipants();
      updateScorePanel();
      updateLobbyHeaderUI();
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
      serveMsgVisible = true;
      lastServePaddleX = null;
      log(`ROOM_CREATED: ${currentRoom.roomId} players=${currentRoom.players.join(',')}`);
      const serveName = participants[serveId] ? participants[serveId].name : serveId;
      log(`${serveName} のサーブです`);
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
      // If game not running and we have a room, keep serve pending (show message)
      if (!gameState.running && currentRoom) {
        servePending = true;
        // ensure ball is positioned near serve paddle (server should already set)
      } else {
        servePending = false;
      }
      // Detect transition from running -> stopped (new serve) to re-show message on subsequent serves
      if (lastRunning === null) {
        lastRunning = gameState.running;
      } else {
        if (lastRunning && !gameState.running) {
          serveMsgVisible = true;
          if (s.paddles && serveId && s.paddles[serveId]) {
            lastServePaddleX = s.paddles[serveId].x;
          } else {
            lastServePaddleX = null;
          }
        }
        lastRunning = gameState.running;
      }
      // Track server paddle movement during pre-serve to hide message (applies to both clients)
      if (servePending && s.paddles && serveId && s.paddles[serveId]) {
        const curX = s.paddles[serveId].x;
        if (lastServePaddleX === null) lastServePaddleX = curX;
        else if (typeof curX === 'number' && Math.abs(curX - lastServePaddleX) >= 1) {
          serveMsgVisible = false;
          if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
          lastServePaddleX = curX;
        }
      }
      if (!servePending) { serveMsgVisible = false; }
      // reflect servePending to score panel emphasis/compact
      if (scorePanelEl) {
        if (servePending && serveMsgVisible) {
          scorePanelEl.classList.add('serve');
          scorePanelEl.classList.remove('compact');
        } else {
          scorePanelEl.classList.remove('serve');
          scorePanelEl.classList.add('compact');
        }
      }
      // Update scoreboard DOM after state is settled
      updateScorePanel();
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

  // Update lobby header (login vs. user bar) depending on join status
  function updateLobbyHeaderUI() {
    try {
      const joinedName = (myId && participants[myId] && participants[myId].name) ? participants[myId].name : '';
      const isJoined = !!joinedName;
      if (isJoined) {
        if (meLabel) meLabel.textContent = `ユーザ: ${joinedName}`;
        if (loginRow) loginRow.classList.add('hidden');
        if (lobbyUserRow) lobbyUserRow.classList.remove('hidden');
      } else {
        if (lobbyUserRow) lobbyUserRow.classList.add('hidden');
        if (loginRow) loginRow.classList.remove('hidden');
      }
    } catch (e) { /* noop */ }
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
    meLabel.textContent = `ユーザ: ${username}`;
    log(`ロビーに入室しました（${username}）`);
    try { usernameInput.blur(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) {}
    connectWs();
    // JOIN_LOBBY を送る（name を登録）— 少し遅らせて id を受け取ってから
    setTimeout(() => {
      safeSend({ type: 'JOIN_LOBBY', senderId: myId, payload: { name: username } });
    }, 300);
    // Switch to lobby UI
    if (loginRow) loginRow.classList.add('hidden');
    if (lobbyUserRow) lobbyUserRow.classList.remove('hidden');
    // iOSでズームが残るのを軽減（若干のスクロールリセット）
    try { setTimeout(() => window.scrollTo(0, 0), 50); } catch (e) {}
  });

  // ロビー退出
  function leaveLobby() {
    try { safeSend({ type: 'DISCONNECT', senderId: myId }); } catch (e) {}
    try { intendedDisconnect = true; if (ws) ws.close(); } catch (e) {}
    ws = null;
    myId = null;
    // keep username so input can be prefilled, but do not consider it joined
    participants = {};
    participantsList.innerHTML = '';
    if (meLabel) meLabel.textContent = '未入室';
    if (lobbyUserRow) lobbyUserRow.classList.add('hidden');
    if (loginRow) loginRow.classList.remove('hidden');
    log('ロビーから退出しました');
  }
  if (leaveLobbyBtn) leaveLobbyBtn.addEventListener('click', leaveLobby);

  // ゲーム画面制御
  function enterGameScreen() {
    lobby.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    // keep running=false until serve
    gameState.running = false;
    try { document.body.classList.add('game-mode'); } catch (e) {}
  }

  function exitGameScreen() {
    gameState.running = false;
    gameScreen.classList.add('hidden');
    lobby.classList.remove('hidden');
    log('ロビーに戻りました');
    try { document.body.classList.remove('game-mode'); } catch (e) {}
    if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.remove('compact'); }
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

    // Overlay: serve message centered if pending and visible
    if (servePending && serveMsgVisible && currentRoom) {
      const serveName = participants[serveId] ? participants[serveId].name : serveId;
      const text = `${serveName} のサーブです。`;
      const w = gameCanvas.width;
      const h = gameCanvas.height;
      ctx.save();
      ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textW = ctx.measureText(text).width;
      const padX = 18;
      const padY = 10;
      const boxW = Math.min(w - 40, textW + padX * 2);
      const boxH = 44;
      const cx = w / 2;
      const cy = h / 2;
      const x = cx - boxW / 2;
      const y = cy - boxH / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y, boxW, boxH);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.strokeRect(x, y, boxW, boxH);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, cx, cy);
      ctx.restore();
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
      if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
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
    // Update emphasize class: only emphasize when serve message is visible
    if (scorePanelEl) {
      if (servePending && serveMsgVisible) { scorePanelEl.classList.add('serve'); scorePanelEl.classList.remove('compact'); }
      else { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
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
    const clientX = ('clientX' in e) ? e.clientX : e.touches[0].clientX;
    const scaleX = gameCanvas.width / rect.width;
    return (clientX - rect.left) * scaleX;
  }
  function getCanvasY(e) {
    const rect = gameCanvas.getBoundingClientRect();
    const clientY = ('clientY' in e) ? e.clientY : e.touches[0].clientY;
    const scaleY = gameCanvas.height / rect.height;
    return (clientY - rect.top) * scaleY;
  }

  gameCanvas.addEventListener('mousedown', (e) => {
    const x = getCanvasX(e);
    const y = getCanvasY(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle || { x: (gameCanvas.width-100)/2, w:100, y: gameCanvas.height-40, h: 12 };
    const drawY = renderYForPaddle(p);
    const fudge = 24;
    if (x >= p.x && x <= p.x + p.w && y >= drawY - fudge && y <= drawY + (p.h || 12) + fudge) {
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
    // If I'm the server and pre-serve, hide serve message on movement
    if (servePending && serveMsgVisible && myId === serveId) {
      serveMsgVisible = false;
      if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
    }
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  // Touch
  gameCanvas.addEventListener('touchstart', (e) => {
    const x = getCanvasX(e);
    const y = getCanvasY(e);
    const p = (gameState.paddles && gameState.paddles[myId]) ? gameState.paddles[myId] : gameState.paddle || { x: (gameCanvas.width-100)/2, w:100, y: gameCanvas.height-40, h: 12 };
    const drawY = renderYForPaddle(p);
    const fudge = 24;
    if (x >= p.x && x <= p.x + p.w && y >= drawY - fudge && y <= drawY + (p.h || 12) + fudge) {
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
    // Hide serve message when server paddle moves (mobile)
    if (servePending && serveMsgVisible && myId === serveId) {
      serveMsgVisible = false;
      if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
    }
  }, { passive: false });

  gameCanvas.addEventListener('touchend', () => {
    const wasDragging = dragging;
    dragging = false;
    // Serve on touch release if pending and I'm the server
    if (!wasDragging && servePending && currentRoom && myId === serveId) {
      log('サーブを実行（タップ解放）');
      safeSend({ type: 'SERVE', senderId: myId, payload: { roomId: currentRoom.roomId, fromId: myId } });
      servePending = false;
      serveMsgVisible = false;
      if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
    } else if (servePending && currentRoom && myId === serveId) {
      // If user dragged paddle then released, still serve on release per request
      log('サーブを実行（ドラッグ後のタップ解放）');
      safeSend({ type: 'SERVE', senderId: myId, payload: { roomId: currentRoom.roomId, fromId: myId } });
      servePending = false;
      serveMsgVisible = false;
      if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
    }
  }, { passive: true });
  gameCanvas.addEventListener('touchcancel', () => { dragging = false; }, { passive: true });

  // Serve on mouse release for desktop
  gameCanvas.addEventListener('mouseup', () => {
    if (!servePending || !currentRoom) return;
    if (myId !== serveId) return; // only server can serve
    log('サーブを実行（マウス解放）');
    safeSend({ type: 'SERVE', senderId: myId, payload: { roomId: currentRoom.roomId, fromId: myId } });
    servePending = false;
    serveMsgVisible = false;
    if (scorePanelEl) { scorePanelEl.classList.remove('serve'); scorePanelEl.classList.add('compact'); }
  });

  // Initialization
  initServerInfo();
  requestAnimationFrame(gameLoop);

  // Debug API
  window.__debug = {
    connectWs,
    safeSend,
    getState: () => ({ myId, username, participants, currentRoom, serveId, servePending, gameState })
  };
})();
