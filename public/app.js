// MAGNATA — cliente
import { BOARD, COLORS, isOwnable } from './board.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PCOLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];
const EMOTES = ['👍', '😂', '😭', '😡', '🔥', '💸', '🤑', '👀'];
const GROUP_NAMES = { marrom: 'Marrom', celeste: 'Celeste', rosa: 'Rosa', laranja: 'Laranja', vermelho: 'Vermelho', amarelo: 'Amarelo', verde: 'Verde', azul: 'Azul' };
const LS = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let S = null;          // estado atual vindo do servidor
let ME = null;         // meu id
let ws = null, room = null, token = null, retry = 0, leaving = false, pingTimer = null;
let displayPos = {}, displayMoney = {};
let queue = [], busy = false;
let selColor = LS.get('mag_color', PCOLORS[0]);
let muted = LS.get('mag_mute') === '1';
let spin = 0;
let modalKind = null;
let lastChatLen = 0, unreadChat = 0, chatOpen = false;
let lastLogLen = 0;
const cells = [];

// ===================================================================== SOM
let actx = null;
function tone(freq, dur = 0.08, type = 'sine', vol = 0.12, when = 0) {
  if (muted) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime + when;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch {}
}
const SFX = {
  tick: () => tone(700, 0.04, 'triangle', 0.06),
  dice: () => { for (let i = 0; i < 9; i++) tone(180 + Math.random() * 380, 0.035, 'square', 0.04, i * 0.08); },
  coin: () => { tone(988, 0.07, 'square', 0.06); tone(1319, 0.2, 'square', 0.06, 0.07); },
  pay: () => { tone(420, 0.1, 'sawtooth', 0.05); tone(300, 0.2, 'sawtooth', 0.05, 0.09); },
  card: () => { tone(520, 0.12, 'triangle', 0.08); tone(780, 0.15, 'triangle', 0.08, 0.1); },
  jail: () => [0, 0.26, 0.52].forEach((w) => { tone(880, 0.12, 'square', 0.05, w); tone(660, 0.12, 'square', 0.05, w + 0.13); }),
  build: () => { tone(300, 0.06, 'square', 0.06); tone(450, 0.06, 'square', 0.06, 0.07); tone(620, 0.12, 'square', 0.06, 0.14); },
  buy: () => [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.09, i * 0.08)),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, i * 0.14)),
  turn: () => { tone(784, 0.1, 'sine', 0.1); tone(1047, 0.18, 'sine', 0.1, 0.1); },
  err: () => tone(160, 0.18, 'sawtooth', 0.06),
  pop: () => tone(900, 0.05, 'sine', 0.06),
  sad: () => [400, 340, 280, 200].forEach((f, i) => tone(f, 0.25, 'sawtooth', 0.05, i * 0.18)),
};

// =================================================================== TOAST
function toast(text, cls = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ==================================================================== HOME
function initHome() {
  const name = LS.get('mag_name', '');
  $('#nameInput').value = name;
  const cp = $('#colorPick');
  cp.innerHTML = PCOLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === selColor ? 'sel' : ''}" aria-label="cor"></button>`).join('');
  cp.onclick = (e) => {
    const c = e.target.dataset?.c; if (!c) return;
    selColor = c; LS.set('mag_color', c);
    cp.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.c === c));
    SFX.pop();
  };
  $('#createBtn').onclick = () => {
    if (!requireName()) return;
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += abc[Math.floor(Math.random() * abc.length)];
    connect(code);
  };
  $('#joinBtn').onclick = () => {
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(code)) { toast('Digite o código da sala.', 'err'); return; }
    if (!requireName()) return;
    connect(code);
  };
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#codeInput').value ? $('#joinBtn') : $('#createBtn')).click(); });

  const q = new URLSearchParams(location.search).get('sala');
  if (q) {
    $('#codeInput').value = q.toUpperCase();
    if (LS.get('mag_tok_' + q.toUpperCase()) || name) connect(q);
  }
}
function requireName() {
  const n = $('#nameInput').value.trim();
  if (!n) { toast('Escolha um nome primeiro!', 'err'); $('#nameInput').focus(); return false; }
  LS.set('mag_name', n);
  return true;
}
function showScreen(id) {
  for (const s of ['home', 'lobby', 'game']) $('#' + s).classList.toggle('hidden', s !== id);
}

// =============================================================== CONEXÃO
function connect(code) {
  room = code.toUpperCase();
  token = LS.get('mag_tok_' + room);
  leaving = false;
  history.replaceState(null, '', '?sala=' + room);
  openSocket();
}
function openSocket() {
  try { ws?.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${room}`);
  ws.onopen = () => {
    retry = 0;
    $('#conn').classList.add('hidden');
    send({ t: 'join', name: LS.get('mag_name', 'Jogador'), color: selColor, token });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws?.readyState === 1) ws.send('ping'); }, 25000);
  };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') {
      ME = m.pid;
      if (m.token) { token = m.token; LS.set('mag_tok_' + room, token); }
      if (m.spectator) toast('A partida já começou — você está assistindo. 👀');
    } else if (m.t === 'update') {
      queue.push(m);
      if (!busy) pump();
    } else if (m.t === 'error') {
      toast(m.msg, 'err'); SFX.err();
    } else if (m.t === 'kicked') {
      toast('Você foi removido da sala.', 'err');
      goHome();
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (leaving || !room) return;
    $('#conn').classList.remove('hidden');
    setTimeout(() => { if (!leaving && room) openSocket(); }, Math.min(8000, 600 * 2 ** retry++));
  };
}
function send(o) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(o));
  else toast('Sem conexão… tentando de novo.', 'err');
}
function goHome() {
  leaving = true;
  try { ws?.close(); } catch {}
  if (room) LS.set('mag_tok_' + room, '');
  room = null; S = null; ME = null; queue = []; displayPos = {}; displayMoney = {};
  history.replaceState(null, '', location.pathname);
  closeModal();
  showScreen('home');
}

// ========================================================== FILA DE EVENTOS
async function pump() {
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    const fast = queue.length > 2;
    const prev = S;
    S = m.state;
    ME = m.you ?? ME;
    if (S.phase === 'lobby') { renderLobby(); continue; }
    ensureGame(prev);
    for (const ev of m.events || []) {
      try { await playEvent(ev, fast); } catch (e) { console.error('evento', e); }
    }
    try { renderGame(); } catch (e) { console.error('render', e); }
  }
  busy = false;
}

function ensureGame(prev) {
  if ($('#game').classList.contains('hidden')) {
    showScreen('game');
    closeModal();
  }
  if (!cells.length) buildBoard();
  for (const p of S.players) {
    if (displayPos[p.id] === undefined || !prev || prev.phase === 'lobby') displayPos[p.id] = p.pos;
    if (displayMoney[p.id] === undefined || !prev || prev.phase === 'lobby') displayMoney[p.id] = p.money;
  }
  if (!prev || prev.phase === 'lobby') { renderGame(); }
}

const P = (id) => S?.players.find((p) => p.id === id);
const me = () => P(ME);
const cur = () => S.players[S.turn];
const pname = (id) => esc(P(id)?.name ?? '?');

async function playEvent(ev, fast) {
  switch (ev.k) {
    case 'start':
      toast('🎲 A partida começou!', 'big');
      break;
    case 'turn':
      if (ev.pid === ME) { toast('É a sua vez! 🎲', 'big', 1800); SFX.turn(); }
      break;
    case 'dice':
      await rollDice(ev.d, fast);
      break;
    case 'move':
      await moveToken(ev, fast);
      break;
    case 'money':
      moneyFx(ev.pid, ev.delta);
      if (!fast) await sleep(220);
      break;
    case 'rent':
      flashCell(ev.sq);
      break;
    case 'card':
      if (!fast) await showCard(ev); else SFX.card();
      break;
    case 'buy':
      SFX.buy();
      flashCell(ev.sq);
      if (!fast) await sleep(300);
      break;
    case 'build':
      if (!ev.sold) SFX.build(); else SFX.pop();
      flashCell(ev.sq);
      break;
    case 'mortgage':
      SFX.pop();
      flashCell(ev.sq);
      break;
    case 'jail':
      SFX.jail();
      toast(`🚔 ${P(ev.pid)?.name} foi para a prisão!`);
      break;
    case 'free':
      toast(`🔓 ${P(ev.pid)?.name} está livre!`);
      break;
    case 'debt':
      if (ev.pid === ME) { toast(`⚠️ Você precisa levantar $${ev.amount}!`, 'err', 4000); SFX.err(); }
      break;
    case 'bankrupt':
      SFX.sad();
      toast(`💀 ${P(ev.pid)?.name} faliu!`, 'big', 3500);
      if (!fast) await sleep(600);
      break;
    case 'win':
      SFX.win();
      confetti();
      break;
    case 'tradeOffer':
      if (ev.to === ME) { SFX.card(); toast('🤝 Você recebeu uma proposta de troca!', 'big'); }
      break;
    case 'tradeDone':
      SFX.buy();
      toast(`🤝 Troca fechada entre ${P(ev.a)?.name} e ${P(ev.b)?.name}!`);
      ev.sqs?.forEach(flashCell);
      break;
    case 'tradeNo':
      toast(`❌ ${P(ev.pid)?.name} recusou a troca.`);
      break;
    case 'emote':
      showEmote(ev.pid, ev.e);
      break;
    case 'joined':
    case 'chat':
      break;
  }
}

// ================================================================ TABULEIRO
function gridPos(i) {
  if (i <= 10) return [11, 11 - i];
  if (i <= 20) return [11 - (i - 10), 1];
  if (i <= 30) return [1, 1 + (i - 20)];
  return [1 + (i - 30), 11];
}
function sideClass(i) {
  if (i % 10 === 0) return 'corner';
  if (i < 10) return 'side-bottom';
  if (i < 20) return 'side-left';
  if (i < 30) return 'side-top-row';
  return 'side-right';
}
function cellHTML(i) {
  const s = BOARD[i];
  switch (s.type) {
    case 'prop':
      return `<div class="band" style="background:${COLORS[s.group]}"></div><div class="info"><div class="nm">${s.name}</div><div class="pr">$${s.price}</div></div><div class="owner"></div>`;
    case 'station': case 'utility':
      return `<div class="info"><div class="nm">${s.name}</div><div class="ico">${s.icon}</div><div class="pr">$${s.price}</div></div><div class="owner"></div>`;
    case 'card':
      return `<div class="info"><div class="nm">${s.name}</div><div class="ico">${s.deck === 'sorte' ? '❓' : '🎁'}</div><div class="pr">&nbsp;</div></div>`;
    case 'tax':
      return `<div class="info"><div class="nm">${s.name}</div><div class="ico">💸</div><div class="pr">$${s.amount}</div></div>`;
    case 'go': return `<div class="ico">🏁</div><div class="nm">Partida</div><div class="pr">Receba $200</div>`;
    case 'jail': return `<div class="ico">🔒</div><div class="nm">Prisão</div><div class="pr">ou só visitando</div>`;
    case 'parking': return `<div class="ico">☕</div><div class="nm">Descanso</div><div class="pr">Relaxa!</div>`;
    case 'gotojail': return `<div class="ico">👮</div><div class="nm">Vá para a prisão</div>`;
  }
}
function buildBoard() {
  const board = $('#board');
  const cornerCls = { go: 'corner-go', jail: 'corner-jail', parking: 'corner-park', gotojail: 'corner-gojail' };
  BOARD.forEach((s, i) => {
    const el = document.createElement('div');
    const [r, c] = gridPos(i);
    el.className = `cell ${sideClass(i)} ${cornerCls[s.type] || ''} ${isOwnable(s) ? 'clickable' : ''}`;
    el.style.gridRow = r; el.style.gridColumn = c;
    el.innerHTML = cellHTML(i);
    el.dataset.i = i;
    if (isOwnable(s)) el.onclick = () => openProp(i);
    board.insertBefore(el, $('#center'));
    cells[i] = el;
  });
  setDice([1, 1], false);
  new ResizeObserver(() => placeTokens()).observe(board);
}

function updateBoard() {
  BOARD.forEach((s, i) => {
    if (!isOwnable(s)) return;
    const el = cells[i];
    const o = S.props[i];
    el.classList.toggle('owned', !!o);
    el.classList.toggle('mortgaged', !!o?.mortgaged);
    const ow = el.querySelector('.owner');
    if (ow) ow.style.background = o ? P(o.owner)?.color || '#999' : 'transparent';
    if (s.type === 'prop') {
      const band = el.querySelector('.band');
      const n = o?.houses || 0;
      const want = n === 5 ? 'H' : String(n);
      if (band.dataset.h !== want) {
        band.dataset.h = want;
        band.innerHTML = n === 5 ? '<span class="hotel"></span>' : '<span class="house"></span>'.repeat(n);
      }
    }
  });
}

function flashCell(i) {
  const el = cells[i]; if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ==================================================================== PEÕES
const OFFS = [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2], [0, -0.05], [0, 0.3]];
function tokenEl(p) {
  let el = document.getElementById('tk-' + p.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'tk-' + p.id;
    el.className = 'token';
    $('#tokens').appendChild(el);
  }
  el.style.background = p.color;
  el.textContent = (p.name[0] || '?').toUpperCase();
  return el;
}
function cellCenter(i, slot = 0) {
  const c = cells[i];
  if (!c) return { x: 0, y: 0 };
  const w = c.offsetWidth, h = c.offsetHeight;
  const [ox, oy] = OFFS[slot % OFFS.length];
  const m = Math.min(w, h) * 1.15;
  return { x: c.offsetLeft + w / 2 + ox * m, y: c.offsetTop + h / 2 + oy * m };
}
function placeTokens() {
  if (!S || !cells.length) return;
  const bySq = {};
  const ids = new Set();
  S.players.forEach((p, idx) => {
    ids.add('tk-' + p.id);
    const el = tokenEl(p);
    const sq = displayPos[p.id] ?? p.pos;
    const slot = idx;
    (bySq[sq] ||= []).push(p.id);
    const { x, y } = cellCenter(sq, slot);
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.classList.toggle('me', p.id === ME);
    el.classList.toggle('active', S.phase === 'playing' && cur()?.id === p.id);
    el.classList.toggle('jailed', !!p.inJail && sq === 10);
    el.classList.toggle('gone', !!p.bankrupt);
    el.title = p.name;
  });
  document.querySelectorAll('.token').forEach((t) => { if (!ids.has(t.id)) t.remove(); });
}
function slotOf(pid) { return Math.max(0, S.players.findIndex((p) => p.id === pid)); }

async function moveToken(ev, fast) {
  const p = P(ev.pid);
  if (!p) return;
  const el = tokenEl(p);
  if (fast) { displayPos[ev.pid] = ev.to; placeTokens(); return; }
  if (ev.direct) {
    el.style.transition = 'left .55s cubic-bezier(.5,-0.4,.5,1.4), top .55s cubic-bezier(.5,-0.4,.5,1.4)';
    displayPos[ev.pid] = ev.to;
    placeTokens();
    await sleep(600);
    el.style.transition = '';
    cells[ev.to]?.classList.add('land'); setTimeout(() => cells[ev.to]?.classList.remove('land'), 600);
    return;
  }
  const n = Math.abs(ev.steps), dir = Math.sign(ev.steps);
  for (let k = 1; k <= n; k++) {
    const sq = (((ev.from + dir * k) % 40) + 40) % 40;
    displayPos[ev.pid] = sq;
    const { x, y } = cellCenter(sq, slotOf(ev.pid));
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.classList.remove('hop'); void el.offsetWidth; el.classList.add('hop');
    SFX.tick();
    if (sq === 0 && dir > 0) { SFX.coin(); flashCell(0); }
    await sleep(n > 12 ? 130 : 175);
  }
  placeTokens();
  const c = cells[ev.to];
  c?.classList.remove('land'); void c?.offsetWidth; c?.classList.add('land');
  await sleep(250);
}

function fxAt(sq, slot, html, cls) {
  const { x, y } = cellCenter(sq, slot);
  const el = document.createElement('div');
  el.className = 'float ' + cls;
  el.innerHTML = html;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  $('#fx').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}
function moneyFx(pid, delta) {
  if (!delta) return;
  displayMoney[pid] = (displayMoney[pid] ?? 0) + delta;
  const p = P(pid);
  if (p) fxAt(displayPos[pid] ?? p.pos, slotOf(pid), (delta > 0 ? '+$' : '−$') + Math.abs(delta), delta > 0 ? 'plus' : 'minus');
  const mEl = document.querySelector(`[data-money="${pid}"]`);
  if (mEl) {
    animateNumber(mEl, displayMoney[pid]);
    mEl.classList.remove('bump-up', 'bump-down'); void mEl.offsetWidth;
    mEl.classList.add(delta > 0 ? 'bump-up' : 'bump-down');
  }
  if (pid === ME) (delta > 0 ? SFX.coin : SFX.pay)();
}
function animateNumber(el, to) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  const t0 = performance.now(), dur = 500;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = '$' + Math.round(from + (to - from) * (1 - (1 - k) ** 3)).toLocaleString('pt-BR');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function showEmote(pid, e) {
  const p = P(pid); if (!p) return;
  const el = tokenEl(p);
  const b = document.createElement('span');
  b.className = 'bubble'; b.textContent = e;
  el.appendChild(b);
  SFX.pop();
  setTimeout(() => b.remove(), 1900);
}

// ==================================================================== DADOS
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const SHOW = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
function buildDie(cube) {
  cube.innerHTML = [1, 2, 3, 4, 5, 6].map((n) => `<div class="face f${n}">${Array.from({ length: 9 }, (_, k) => (PIPS[n].includes(k) ? '<i style="grid-area:' + (Math.floor(k / 3) + 1) + '/' + ((k % 3) + 1) + '"></i>' : '')).join('')}</div>`).join('');
}
function setDice(d, animate) {
  [0, 1].forEach((k) => {
    const cube = $(`#die${k} .cube`);
    if (!cube.children.length) buildDie(cube);
    const [rx, ry] = SHOW[d[k]];
    const extra = animate ? 360 * (spin + k) : 360 * spin;
    if (!animate) cube.style.transition = 'none';
    cube.style.transform = `rotateX(${rx + extra}deg) rotateY(${ry + extra}deg)`;
    if (!animate) { void cube.offsetWidth; cube.style.transition = ''; }
  });
}
async function rollDice(d, fast) {
  if (fast) { setDice(d, false); return; }
  spin += 2;
  SFX.dice();
  const area = document.querySelector('.dice-area');
  area.classList.remove('rolling'); void area.offsetWidth; area.classList.add('rolling');
  setDice(d, true);
  await sleep(1050);
  if (d[0] === d[1]) toast('🎲 DUPLA!', '', 1400);
}

// ==================================================================== CARTA
function showCard(ev) {
  return new Promise((resolve) => {
    const ov = $('#cardOverlay'), card = $('#gameCard');
    const sorte = ev.deck === 'sorte';
    card.className = 'game-card ' + (sorte ? 'sorte' : 'surpresa');
    $('#gcDeck').textContent = sorte ? 'SORTE' : 'SURPRESA';
    $('#gcIcon').textContent = sorte ? '❓' : '🎁';
    $('#gcBackIcon').textContent = sorte ? '❓' : '🎁';
    $('#gcText').textContent = ev.text;
    $('#gcWho').textContent = P(ev.pid)?.name ? `tirada por ${P(ev.pid).name}` : '';
    ov.classList.remove('hidden');
    SFX.card();
    setTimeout(() => card.classList.add('flipped'), 450);
    let done = false;
    const close = () => { if (done) return; done = true; ov.classList.add('hidden'); ov.onclick = null; resolve(); };
    ov.onclick = close;
    setTimeout(close, 3200);
  });
}

// =================================================================== LOBBY
function renderLobby() {
  showScreen('lobby');
  closeModal();
  cells.length = 0;
  document.querySelectorAll('.cell, .token').forEach((e) => e.remove());
  displayPos = {}; displayMoney = {};
  $('#roomCode').textContent = room;
  const host = S.hostId === ME;
  $('#lobbyPlayers').innerHTML = S.players.map((p) => `
    <li><span class="pawn" style="background:${p.color}">${esc(p.name[0]?.toUpperCase())}</span>
    <span>${esc(p.name)}${p.id === ME ? ' <small style="color:var(--muted)">(você)</small>' : ''}</span>
    ${p.id === S.hostId ? '👑' : ''} ${p.connected ? '' : '<span class="dot off" title="offline"></span>'}
    ${host && p.id !== ME ? `<button class="kick" data-kick="${p.id}" title="Remover">✕</button>` : ''}</li>`).join('');
  $('#lobbyPlayers').querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => send({ t: 'kick', pid: b.dataset.kick })));
  const n = S.players.length;
  $('#startBtn').classList.toggle('hidden', !host);
  $('#startBtn').disabled = n < 2;
  $('#lobbyHint').textContent = !ME ? 'Entrando…'
    : host ? (n < 2 ? 'Mande o link pros amigos. Precisa de pelo menos 2 jogadores.' : `${n} jogadores prontos. Bora!`)
    : 'Esperando o anfitrião começar a partida…';
}

// ===================================================================== JOGO
function renderGame() {
  if (!S || S.phase === 'lobby') return;
  for (const p of S.players) { displayPos[p.id] = p.pos; displayMoney[p.id] = p.money; }
  updateBoard();
  placeTokens();
  setDice(S.lastDice, false);
  renderPlayers();
  renderCenter();
  renderSide();
  maybeTradeModal();
  if (modalKind?.startsWith('prop:')) openProp(Number(modalKind.slice(5)), true);
  if (modalKind === 'myprops') openMyProps(true);
}

function renderPlayers() {
  $('#roomPill').textContent = 'Sala ' + room;
  $('#roundPill').textContent = S.phase === 'playing' ? `Rodada ${S.round}` : S.phase === 'ended' ? 'Fim de jogo' : '';
  $('#players').innerHTML = S.players.map((p, idx) => {
    const props = Object.keys(S.props).map(Number).filter((i) => S.props[i].owner === p.id).sort((a, b) => a - b);
    const chips = props.map((i) => {
      const s = BOARD[i];
      const col = s.type === 'prop' ? COLORS[s.group] : s.type === 'station' ? '#334155' : '#94a3b8';
      return `<span class="chip ${S.props[i].mortgaged ? 'mort' : ''}" style="background:${col}" title="${esc(s.name)}"></span>`;
    }).join('');
    const icons = [p.inJail ? '🔒' : '', p.jailCards ? `🎫${p.jailCards > 1 ? '×' + p.jailCards : ''}` : '', p.id === S.hostId ? '👑' : '', S.winner === p.id ? '🏆' : ''].join('');
    return `<div class="pcard ${S.phase === 'playing' && S.turn === idx ? 'turn' : ''} ${p.bankrupt ? 'broke' : ''}">
      <span class="pawn" style="background:${p.color}">${esc(p.name[0]?.toUpperCase())}</span>
      <span class="pname"><span class="n">${esc(p.name)}${p.id === ME ? ' (você)' : ''}</span> ${icons} <span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'online' : 'offline'}"></span></span>
      <span class="pmoney" data-money="${p.id}" data-v="${p.money}">${p.bankrupt ? 'FALIU' : '$' + p.money.toLocaleString('pt-BR')}</span>
      <span class="chips">${chips}</span>
    </div>`;
  }).join('');
}

function renderCenter() {
  const c = cur();
  const m = me();
  const isTurn = S.phase === 'playing' && c?.id === ME;
  const myDebt = S.debts.find((d) => d.pid === ME);
  const label = $('#turnLabel');
  const A = $('#actions');

  if (S.phase === 'ended') {
    const w = P(S.winner);
    label.innerHTML = w ? `🏆 ${esc(w.name)} venceu!` : 'Fim de jogo';
    A.innerHTML = `<div class="msg">${w ? `${esc(w.name)} é o grande MAGNATA!` : ''}</div>` +
      (S.hostId === ME ? `<button class="btn primary big" data-a="restart">Jogar de novo</button>` : `<div class="msg"><small>Esperando o anfitrião iniciar outra partida…</small></div>`);
    bindActions();
    return;
  }

  label.innerHTML = c ? `<span class="pawn" style="background:${c.color}">${esc(c.name[0]?.toUpperCase())}</span> ${isTurn ? 'Sua vez!' : 'Vez de ' + esc(c.name)}` : '';
  let h = '';

  if (myDebt) {
    const to = myDebt.to ? P(myDebt.to)?.name : 'o banco';
    const missing = Math.max(0, myDebt.amount - m.money);
    h += `<div class="debt-box">Você deve <b>$${myDebt.amount}</b> para ${esc(to)}<br>
      <small>${missing ? `Faltam $${missing}. Venda casas ou hipoteque em "Meus imóveis".` : 'Você já tem o dinheiro!'}</small></div>
      <div class="row">
        <button class="btn green ${missing ? '' : 'pulse'}" data-a="payDebt" ${missing ? 'disabled' : ''}>Pagar $${myDebt.amount}</button>
        <button class="btn" data-a="myprops">🏘️ Meus imóveis</button>
        <button class="btn red" data-a="bankrupt">Falência</button>
      </div>`;
  } else if (isTurn) {
    if (S.turnPhase === 'roll') {
      if (m.inJail) {
        h += `<div class="msg">🔒 Você está preso <small>Tentativa ${m.jailTries + 1} de 3</small></div>
          <div class="row">
            <button class="btn primary pulse" data-a="roll">🎲 Tentar dupla</button>
            <button class="btn" data-a="jailPay" ${m.money < 50 ? 'disabled' : ''}>Pagar $50</button>
            ${m.jailCards ? '<button class="btn green" data-a="jailCard">🎫 Usar carta</button>' : ''}
          </div>`;
      } else {
        h += `<button class="btn primary big pulse" data-a="roll">🎲 Rolar dados</button>`;
        if (S.doubles > 0) h += `<div class="msg"><small>Você tirou dupla — jogue de novo!</small></div>`;
      }
    } else if (S.turnPhase === 'decide' && S.pending?.type === 'buy') {
      const s = BOARD[S.pending.sq];
      const band = s.type === 'prop' ? COLORS[s.group] : '#334155';
      h += `<div class="buy-box"><div class="bb-band" style="background:${band}">${s.icon || ''} ${esc(s.name)}</div>
        <div class="bb-body"><div class="bb-price">$${s.price}</div>${rentPreview(S.pending.sq)}</div></div>
        <div class="row">
          <button class="btn green pulse" data-a="buy" ${m.money < s.price ? 'disabled' : ''}>Comprar</button>
          <button class="btn" data-a="pass">Passar</button>
          <button class="btn ghost" data-prop="${S.pending.sq}">Detalhes</button>
        </div>
        ${m.money < s.price ? '<div class="msg"><small>Sem dinheiro. Hipoteque algo em "Meus imóveis" ou passe.</small></div>' : ''}`;
    } else if (S.turnPhase === 'done') {
      h += `<button class="btn primary big" data-a="end">Encerrar vez ➜</button>
        <div class="msg"><small>Construa casas ou negocie antes de passar a vez.</small></div>`;
    }
  } else if (c) {
    let what = 'está jogando…';
    if (S.turnPhase === 'roll') what = c.inJail ? 'está tentando sair da prisão…' : 'vai rolar os dados…';
    if (S.turnPhase === 'decide' && S.pending) what = `está decidindo se compra ${esc(BOARD[S.pending.sq].name)}…`;
    if (S.turnPhase === 'done') what = 'está terminando a jogada…';
    h += `<div class="msg">${esc(c.name)} ${what}${!c.connected ? '<small>⚠️ jogador offline</small>' : ''}</div>`;
    if (!c.connected && S.hostId === ME) h += `<button class="btn" data-a="skip">⏭️ Pular vez de ${esc(c.name)}</button>`;
    if (!m) h += `<div class="msg"><small>👀 Você está assistindo</small></div>`;
    else if (m.bankrupt) h += `<div class="msg"><small>💀 Você faliu — agora é só torcer</small></div>`;
  }

  if (S.trade && S.trade.from === ME) {
    h += `<div class="msg"><small>🤝 Aguardando ${pname(S.trade.to)} responder sua proposta…</small></div>
      <button class="btn small ghost" data-a="tradeCancel">Cancelar proposta</button>`;
  }
  const others = S.debts.filter((d) => d.pid !== ME);
  if (others.length) h += `<div class="msg"><small>⏳ ${others.map((d) => pname(d.pid)).join(', ')} precisa pagar uma dívida</small></div>`;

  A.innerHTML = h;
  bindActions();
}

function rentPreview(i) {
  const s = BOARD[i];
  if (s.type === 'prop') return `<small>Aluguel $${s.rent[0]} · com hotel $${s.rent[5]}</small>`;
  if (s.type === 'station') return '<small>Aluguel $25 a $200 (por estações)</small>';
  return '<small>Aluguel 4× ou 10× os dados</small>';
}

function bindActions() {
  document.querySelectorAll('#actions [data-a]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'myprops') return openMyProps();
      if (a === 'bankrupt') return confirmBox('Declarar falência?', 'Você sai do jogo e seus bens vão para quem você deve (ou para o banco).', 'Falir 💀', () => send({ t: 'bankrupt' }));
      b.disabled = true;
      send({ t: a });
    };
  });
  document.querySelectorAll('#actions [data-prop]').forEach((b) => (b.onclick = () => openProp(Number(b.dataset.prop))));
}

function renderSide() {
  const m = me();
  const active = S.phase === 'playing' && m && !m.bankrupt;
  $('#toolRow').classList.toggle('hidden', !active);
  $('#emotes').classList.toggle('hidden', !m);

  if (S.log.length !== lastLogLen) {
    lastLogLen = S.log.length;
    const ul = $('#logList');
    ul.innerHTML = S.log.slice(-60).map((l) => `<li>${esc(l.text)}</li>`).join('');
    ul.scrollTop = ul.scrollHeight;
  }
  if (S.chat.length !== lastChatLen) {
    const added = Math.max(0, S.chat.length - lastChatLen);
    lastChatLen = S.chat.length;
    const ul = $('#chatList');
    ul.innerHTML = S.chat.map((c) => `<li><b style="color:${c.color}">${esc(c.name)}:</b> ${esc(c.text)}</li>`).join('') || '<li style="color:var(--muted)">Nenhuma mensagem ainda. Provoque seus amigos!</li>';
    ul.scrollTop = ul.scrollHeight;
    if (!chatOpen && added && S.chat.at(-1)?.name !== m?.name) {
      unreadChat += added;
      $('#chatBadge').textContent = unreadChat;
      $('#chatBadge').classList.remove('hidden');
      SFX.pop();
    }
  }
}

// =================================================================== MODAIS
function openModal(html, kind) {
  modalKind = kind || null;
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  modalKind = null;
  $('#modal').classList.add('hidden');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' && modalKind !== 'tradeIn') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalKind !== 'tradeIn') closeModal(); });

function confirmBox(title, text, okLabel, onOk) {
  openModal(`<h2>${title}</h2><p style="color:var(--muted);font-weight:600">${text}</p>
    <div class="close-row"><button class="btn ghost" id="cNo">Cancelar</button><button class="btn red" id="cYes">${okLabel}</button></div>`, 'confirm');
  $('#cNo').onclick = closeModal;
  $('#cYes').onclick = () => { closeModal(); onOk(); };
}

function deedHTML(i) {
  const s = BOARD[i];
  const o = S.props[i];
  const band = s.type === 'prop' ? COLORS[s.group] : s.type === 'station' ? '#334155' : '#64748b';
  let rows = '';
  if (s.type === 'prop') {
    const labels = ['Aluguel', 'Com 1 casa', 'Com 2 casas', 'Com 3 casas', 'Com 4 casas', 'Com HOTEL'];
    rows = labels.map((l, k) => `<tr class="${o && o.houses === k ? 'cur' : ''}"><td>${l}${k === 0 ? ' <small>(dobra com o grupo)</small>' : ''}</td><td>$${s.rent[k]}</td></tr>`).join('');
    rows += `<tr><td>Custo por casa/hotel</td><td>$${s.house}</td></tr>`;
  } else if (s.type === 'station') {
    rows = [1, 2, 3, 4].map((n) => `<tr><td>Com ${n} ${n > 1 ? 'estações' : 'estação'}</td><td>$${25 * 2 ** (n - 1)}</td></tr>`).join('');
  } else {
    rows = `<tr><td>Com 1 companhia</td><td>4× dados</td></tr><tr><td>Com as 2</td><td>10× dados</td></tr>`;
  }
  rows += `<tr><td>Hipoteca</td><td>$${Math.floor(s.price / 2)}</td></tr>`;
  const owner = o ? P(o.owner) : null;
  const foot = owner
    ? `Dono: <b style="color:${owner.color}">${esc(owner.name)}</b>${o.mortgaged ? ' · 🏦 hipotecada' : ''}${o.houses ? ` · ${o.houses === 5 ? 'hotel' : o.houses + ' casa(s)'}` : ''}`
    : `À venda por $${s.price}`;
  return `<div class="deed"><div class="d-band" style="background:${band}"><small>${s.type === 'prop' ? 'GRUPO ' + GROUP_NAMES[s.group].toUpperCase() : s.type === 'station' ? 'ESTAÇÃO' : 'COMPANHIA'}</small><b>${s.icon || ''} ${esc(s.name)}</b></div>
    <table>${rows}</table><div class="d-foot">${foot}</div></div>`;
}

function openProp(i, refresh) {
  if (refresh && !modalKind?.startsWith('prop:')) return;
  const s = BOARD[i];
  const o = S.props[i];
  const mine = o && o.owner === ME && S.phase === 'playing' && !me()?.bankrupt;
  let acts = '';
  if (mine) {
    const b = [];
    if (s.type === 'prop' && o.houses < 5 && !o.mortgaged) b.push(`<button class="btn green" data-pa="build">🏡 ${o.houses === 4 ? 'Hotel' : 'Casa'} (−$${s.house})</button>`);
    if (s.type === 'prop' && o.houses > 0) b.push(`<button class="btn" data-pa="sell">Vender (+$${Math.floor(s.house / 2)})</button>`);
    if (!o.mortgaged && !o.houses) b.push(`<button class="btn" data-pa="mortgage">🏦 Hipotecar (+$${Math.floor(s.price / 2)})</button>`);
    if (o.mortgaged) b.push(`<button class="btn primary" data-pa="unmortgage">Resgatar (−$${Math.ceil(s.price / 2 * 1.1)})</button>`);
    acts = `<div class="prop-actions">${b.join('')}</div>`;
  }
  openModal(deedHTML(i) + acts + `<div class="close-row">${refresh || modalKind === 'myprops' ? '' : ''}<button class="btn ghost" id="mClose">Fechar</button></div>`, 'prop:' + i);
  $('#mClose').onclick = closeModal;
  document.querySelectorAll('[data-pa]').forEach((btn) => (btn.onclick = () => send({ t: btn.dataset.pa, sq: i })));
}

function openMyProps(refresh) {
  if (refresh && modalKind !== 'myprops') return;
  const list = Object.keys(S.props).map(Number).filter((i) => S.props[i].owner === ME).sort((a, b) => a - b);
  const items = list.map((i) => {
    const s = BOARD[i], o = S.props[i];
    const col = s.type === 'prop' ? COLORS[s.group] : '#334155';
    const meta = o.mortgaged ? '🏦 hipotecada' : o.houses === 5 ? '🏨 hotel' : o.houses ? '🏡'.repeat(o.houses) : `$${s.price}`;
    return `<div class="mp" data-i="${i}"><span class="sw" style="background:${col}"></span>${s.icon || ''} ${esc(s.name)}<span class="meta">${meta}</span></div>`;
  }).join('');
  openModal(`<h2>🏘️ Meus imóveis</h2><p style="color:var(--muted);font-weight:600;margin-top:-6px">Toque num imóvel para construir, vender ou hipotecar.</p>
    <div class="my-props">${items || '<p style="color:var(--muted)">Você ainda não tem imóveis.</p>'}</div>
    <div class="close-row"><button class="btn ghost" id="mClose">Fechar</button></div>`, 'myprops');
  $('#mClose').onclick = closeModal;
  document.querySelectorAll('.mp').forEach((el) => (el.onclick = () => openProp(Number(el.dataset.i))));
}

// ------------------------------------------------------------------ trocas
function tradeable(pid) {
  return Object.keys(S.props).map(Number).filter((i) => {
    if (S.props[i].owner !== pid) return false;
    const s = BOARD[i];
    if (s.type !== 'prop') return true;
    return !BOARD.some((x, j) => x.group === s.group && (S.props[j]?.houses || 0) > 0);
  }).sort((a, b) => a - b);
}
function propLabel(i) {
  const s = BOARD[i];
  const col = s.type === 'prop' ? COLORS[s.group] : '#334155';
  return `<span class="sw" style="background:${col}"></span>${s.icon || ''} ${esc(s.name)}${S.props[i]?.mortgaged ? ' 🏦' : ''}`;
}
function openTrade(targetId) {
  if (S.trade) { toast(S.trade.from === ME ? 'Você já tem uma proposta aberta.' : 'Já existe uma troca em andamento.', 'err'); return; }
  const others = S.players.filter((p) => p.id !== ME && !p.bankrupt);
  if (!others.length) return;
  const t = P(targetId) && !P(targetId).bankrupt ? P(targetId) : others[0];
  const mine = tradeable(ME), theirs = tradeable(t.id);
  const col = (list, side) => list.length ? list.map((i) => `<label><input type="checkbox" data-side="${side}" value="${i}">${propLabel(i)}</label>`).join('') : '<span class="empty">Nenhum imóvel negociável</span>';
  openModal(`<h2>🤝 Propor troca</h2>
    <div class="select-row">${others.map((p) => `<button data-t="${p.id}" class="${p.id === t.id ? 'sel' : ''}"><span class="pawn" style="background:${p.color}">${esc(p.name[0]?.toUpperCase())}</span>${esc(p.name)}</button>`).join('')}</div>
    <div class="trade-cols">
      <div class="trade-col"><h3>Você dá</h3>${col(mine, 'give')}<label>💵 Dinheiro<input type="number" id="giveMoney" min="0" max="${me().money}" value="0"></label></div>
      <div class="trade-col"><h3>Você recebe de ${esc(t.name)}</h3>${col(theirs, 'get')}<label>💵 Dinheiro<input type="number" id="getMoney" min="0" max="${t.money}" value="0"></label></div>
    </div>
    <div class="close-row"><button class="btn ghost" id="mClose">Cancelar</button><button class="btn primary" id="tSend">Enviar proposta</button></div>`, 'trade');
  $('#mClose').onclick = closeModal;
  document.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { closeModal(); openTrade(b.dataset.t); }));
  $('#tSend').onclick = () => {
    const pick = (side) => [...document.querySelectorAll(`input[data-side="${side}"]:checked`)].map((x) => Number(x.value));
    send({
      t: 'trade', to: t.id,
      give: { props: pick('give'), money: Number($('#giveMoney').value) || 0 },
      get: { props: pick('get'), money: Number($('#getMoney').value) || 0 },
    });
    closeModal();
  };
}
function maybeTradeModal() {
  const t = S.trade;
  if (t && t.to === ME) {
    if (modalKind === 'tradeIn:' + t.id) return;
    const list = (props, money) => [...props.map((i) => `• ${propLabel(i)}`), money ? `• 💵 $${money}` : ''].filter(Boolean).join('<br>') || '• nada';
    openModal(`<h2>🤝 Proposta de ${pname(t.from)}</h2>
      <div class="trade-cols">
        <div class="trade-summary"><b>Você recebe:</b><br>${list(t.give.props, t.give.money)}</div>
        <div class="trade-summary"><b>Você dá:</b><br>${list(t.get.props, t.get.money)}</div>
      </div>
      <div class="close-row"><button class="btn red" id="tNo">Recusar</button><button class="btn green" id="tYes">Aceitar</button></div>`, 'tradeIn:' + t.id);
    modalKind = 'tradeIn:' + t.id;
    $('#tNo').onclick = () => { send({ t: 'tradeReply', accept: false }); closeModal(); };
    $('#tYes').onclick = () => { send({ t: 'tradeReply', accept: true }); closeModal(); };
  } else if (modalKind?.startsWith('tradeIn:')) {
    closeModal();
  }
}

function openRules() {
  openModal(`<h2>❔ Como jogar</h2><div class="rules">
    <h3>Objetivo</h3>Ser o último jogador sem falir.
    <h3>Na sua vez</h3><ul>
      <li>Role os dados e ande. Passou pela <b>Partida</b>? Ganha $200.</li>
      <li>Caiu numa cidade livre: compre ou passe. Caiu na de alguém: pague aluguel.</li>
      <li>Tirou <b>dupla</b>? Joga de novo. Três duplas seguidas = prisão.</li></ul>
    <h3>Construção</h3><ul>
      <li>Tenha todas as cidades de uma cor para dobrar o aluguel e poder construir.</li>
      <li>Construa de forma equilibrada; 4 casas viram um <b>hotel</b>.</li></ul>
    <h3>Aperto financeiro</h3><ul>
      <li>Venda casas pela metade do preço ou hipoteque imóveis.</li>
      <li>Se não der para pagar, é falência — seus bens vão para o credor.</li></ul>
    <h3>Prisão</h3><ul><li>Pague $50, use uma carta ou tente tirar dupla (até 3 vezes).</li></ul>
    <h3>Negociação</h3><ul><li>Troque imóveis e dinheiro com qualquer jogador a qualquer momento.</li></ul>
    </div><div class="close-row"><button class="btn primary" id="mClose">Entendi!</button></div>`, 'rules');
  $('#mClose').onclick = closeModal;
}

// ================================================================= CONFETTI
function confetti() {
  const cv = $('#confetti'), ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const cols = ['#ffc93c', '#ef4444', '#22c55e', '#3b82f6', '#a855f7', '#f97316', '#fff'];
  const ps = Array.from({ length: 220 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.6,
    vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4,
    r: 4 + Math.random() * 6, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3,
    c: cols[Math.floor(Math.random() * cols.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (t - t0 < 5000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
  })(t0);
}

// ================================================================== BOTÕES
function initUI() {
  $('#copyLink').onclick = async () => {
    const url = `${location.origin}${location.pathname}?sala=${room}`;
    try { await navigator.clipboard.writeText(url); toast('Link copiado! Mande pros amigos 📨'); }
    catch { prompt('Copie o link:', url); }
  };
  $('#roomPill').onclick = () => $('#copyLink').click();
  $('#startBtn').onclick = () => send({ t: 'start' });
  $('#leaveBtn').onclick = () => { send({ t: 'leave' }); setTimeout(goHome, 150); };
  $('#tradeBtn').onclick = () => openTrade();
  $('#myPropsBtn').onclick = () => openMyProps();
  $('#rulesBtn').onclick = openRules;
  $('#quitBtn').onclick = () => confirmBox('Desistir da partida?', 'Seus imóveis voltam para o banco e você passa a só assistir.', 'Desistir', () => send({ t: 'bankrupt' }));
  const mb = $('#muteBtn');
  mb.textContent = muted ? '🔇' : '🔊';
  mb.onclick = () => { muted = !muted; LS.set('mag_mute', muted ? '1' : '0'); mb.textContent = muted ? '🔇' : '🔊'; if (!muted) SFX.pop(); };
  $('#emotes').innerHTML = EMOTES.map((e) => `<button data-e="${e}">${e}</button>`).join('');
  let lastEmote = 0;
  $('#emotes').onclick = (ev) => {
    const e = ev.target.dataset?.e; if (!e) return;
    if (Date.now() - lastEmote < 1200) return;
    lastEmote = Date.now();
    send({ t: 'emote', e });
  };
  document.querySelectorAll('.tab').forEach((tb) => (tb.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tb));
    chatOpen = tb.dataset.tab === 'chat';
    $('#logPanel').classList.toggle('hidden', chatOpen);
    $('#chatPanel').classList.toggle('hidden', !chatOpen);
    if (chatOpen) { unreadChat = 0; $('#chatBadge').classList.add('hidden'); $('#chatInput').focus(); const ul = $('#chatList'); ul.scrollTop = ul.scrollHeight; }
  }));
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    send({ t: 'chat', text: v });
    $('#chatInput').value = '';
  };
  // atalho: espaço rola os dados / encerra a vez
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.tagName === 'INPUT' || modalKind) return;
    const b = document.querySelector('#actions [data-a="roll"], #actions [data-a="end"]');
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  });
}

initUI();
initHome();
