// MAGNATA — servidor (Cloudflare Worker + Durable Object)
// Cada sala é um Durable Object que guarda o estado do jogo e fala com os
// jogadores por WebSocket. Toda a regra roda aqui (servidor autoritativo).

import { DurableObject } from 'cloudflare:workers';
import { BOARD, CARDS, isOwnable } from '../public/board.js';

const START_MONEY = 1500;
const GO_SALARY = 200;
const JAIL_FINE = 50;
const MAX_PLAYERS = 6;
const PCOLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];

const STATIONS = BOARD.map((s, i) => (s.type === 'station' ? i : -1)).filter((i) => i >= 0);
const UTILS = BOARD.map((s, i) => (s.type === 'utility' ? i : -1)).filter((i) => i >= 0);
const GROUP = {};
BOARD.forEach((s, i) => { if (s.group) (GROUP[s.group] ||= []).push(i); });

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = (n = 8) => crypto.randomUUID().replace(/-/g, '').slice(0, n);
const clean = (s, n = 16) => String(s ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const int = (v) => Math.max(0, Math.floor(Number(v) || 0));
const d6 = () => 1 + Math.floor(Math.random() * 6);

function newGame() {
  return {
    phase: 'lobby',           // lobby | playing | ended
    players: [],
    hostId: null,
    turn: 0,
    turnPhase: 'roll',        // roll | decide | done
    doubles: 0,
    rollAgain: false,
    lastDice: [1, 1],
    props: {},                // casa -> { owner, houses, mortgaged }
    pending: null,            // { type:'buy', sq, pid }
    debts: [],                // { pid, amount, to, reason }
    trade: null,
    log: [],
    chat: [],
    decks: null,
    winner: null,
    round: 1,
  };
}

// ------------------------------------------------------------------ Worker
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Esperado WebSocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// ------------------------------------------------------------ Sala de jogo
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.g = null;
    this.ev = [];
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => { this.g = (await ctx.storage.get('g')) || null; });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!this.g) this.g = newGame();
    this.ev = [];
    let err;
    try { err = this.handle(ws, m); } catch (e) { console.error(e); err = 'Erro no servidor: ' + e.message; }
    if (err) { this.send(ws, { t: 'error', msg: err }); return; }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, 'tchau'); } catch {}
    await this.dropSocket(ws);
  }

  async webSocketError(ws) { await this.dropSocket(ws); }

  async dropSocket(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid || !this.g) return;
    const still = this.ctx.getWebSockets().some((w) => w !== ws && w.readyState === 1 && w.deserializeAttachment()?.pid === pid);
    if (still) return;
    const p = this.P(pid);
    if (!p || !p.connected) return;
    p.connected = false;
    this.ev = [];
    this.log(`${p.name} desconectou.`);
    await this.save();
    this.broadcast();
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) { await this.ctx.storage.setAlarm(Date.now() + 6 * 3600e3); return; }
    await this.ctx.storage.deleteAll();
    this.g = null;
  }

  async save() {
    await this.ctx.storage.put('g', this.g);
    await this.ctx.storage.setAlarm(Date.now() + 3 * 24 * 3600e3); // apaga a sala após 3 dias parada
  }

  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }

  broadcast() {
    const { decks, ...rest } = this.g;
    const state = { ...rest, players: rest.players.map(({ token, ...p }) => p) };
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      this.send(ws, { t: 'update', state, you: a.pid || null, events: this.ev });
    }
  }

  // ---------------------------------------------------------- utilitários
  P(id) { return this.g.players.find((p) => p.id === id); }
  cur() { return this.g.players[this.g.turn]; }
  alive() { return this.g.players.filter((p) => !p.bankrupt); }
  log(text) { this.g.log.push({ t: Date.now(), text }); if (this.g.log.length > 80) this.g.log.splice(0, this.g.log.length - 80); }
  e(o) { this.ev.push(o); }
  owned(pid) { return Object.keys(this.g.props).map(Number).filter((i) => this.g.props[i].owner === pid); }
  groupHasHouses(i) { const s = BOARD[i]; return s.type === 'prop' && GROUP[s.group].some((j) => (this.g.props[j]?.houses || 0) > 0); }
  ownsGroup(pid, group) { return GROUP[group].every((j) => this.g.props[j]?.owner === pid); }

  // ------------------------------------------------------------ mensagens
  handle(ws, m) {
    const g = this.g;
    if (m.t === 'join') return this.join(ws, m);

    const me = this.P(ws.deserializeAttachment()?.pid);
    if (!me) return 'Você está assistindo a partida.';

    switch (m.t) {
      case 'chat': {
        const text = clean(m.text, 200);
        if (!text) return 'Mensagem vazia.';
        g.chat.push({ t: Date.now(), name: me.name, color: me.color, text });
        if (g.chat.length > 80) g.chat.splice(0, g.chat.length - 80);
        this.e({ k: 'chat', pid: me.id });
        return;
      }
      case 'emote': {
        const em = ['👍', '😂', '😭', '😡', '🔥', '💸', '🤑', '👀'].includes(m.e) ? m.e : null;
        if (!em) return 'Emote inválido.';
        this.e({ k: 'emote', pid: me.id, e: em });
        return;
      }
      case 'kick': {
        if (g.phase !== 'lobby') return 'Só dá para remover jogadores no lobby.';
        if (me.id !== g.hostId) return 'Só o anfitrião pode remover jogadores.';
        const t = this.P(m.pid);
        if (!t || t.id === me.id) return 'Jogador inválido.';
        g.players = g.players.filter((p) => p.id !== t.id);
        this.log(`${t.name} foi removido da sala.`);
        for (const w of this.ctx.getWebSockets()) if (w.deserializeAttachment()?.pid === t.id) { this.send(w, { t: 'kicked' }); w.serializeAttachment({ pid: null }); }
        return;
      }
      case 'leave': {
        if (g.phase !== 'lobby') return 'Durante a partida use "Desistir".';
        g.players = g.players.filter((p) => p.id !== me.id);
        if (g.hostId === me.id) g.hostId = g.players[0]?.id || null;
        ws.serializeAttachment({ pid: null });
        this.log(`${me.name} saiu da sala.`);
        return;
      }
      case 'start': {
        if (g.phase !== 'lobby') return 'O jogo já começou.';
        if (me.id !== g.hostId) return 'Só o anfitrião pode iniciar.';
        if (g.players.length < 2) return 'Precisa de pelo menos 2 jogadores.';
        shuffle(g.players);
        g.phase = 'playing';
        g.turn = 0; g.turnPhase = 'roll'; g.doubles = 0; g.rollAgain = false; g.round = 1;
        g.decks = { sorte: shuffle([...CARDS.sorte.keys()]), surpresa: shuffle([...CARDS.surpresa.keys()]) };
        this.log(`🎲 A partida começou! ${this.cur().name} joga primeiro.`);
        this.e({ k: 'start' });
        this.e({ k: 'turn', pid: this.cur().id });
        return;
      }
      case 'restart': {
        if (g.phase !== 'ended') return 'A partida ainda não terminou.';
        if (me.id !== g.hostId) return 'Só o anfitrião pode reiniciar.';
        const players = g.players.map((p) => ({ ...p, money: START_MONEY, pos: 0, inJail: false, jailTries: 0, jailCards: 0, bankrupt: false }));
        const chat = g.chat;
        this.g = { ...newGame(), players, hostId: g.hostId, chat };
        this.log('Nova partida! Esperando o anfitrião iniciar.');
        return;
      }
    }

    if (g.phase !== 'playing') return 'A partida não está em andamento.';
    if (me.bankrupt) return 'Você faliu — agora só pode assistir.';
    const myTurn = this.cur().id === me.id;
    const myDebt = g.debts.find((d) => d.pid === me.id);

    switch (m.t) {
      case 'roll': {
        if (!myTurn) return 'Não é sua vez.';
        if (g.turnPhase !== 'roll') return 'Agora não dá para rolar os dados.';
        if (myDebt) return 'Pague sua dívida antes.';
        if (g.trade) return 'Há uma proposta de troca pendente.';
        return this.roll(me);
      }
      case 'buy': {
        const pd = g.pending;
        if (!pd || pd.type !== 'buy' || pd.pid !== me.id) return 'Não há nada para comprar.';
        const s = BOARD[pd.sq];
        if (me.money < s.price) return 'Dinheiro insuficiente. Hipoteque ou venda algo, ou passe a vez.';
        me.money -= s.price;
        g.props[pd.sq] = { owner: me.id, houses: 0, mortgaged: false };
        this.e({ k: 'money', pid: me.id, delta: -s.price });
        this.e({ k: 'buy', pid: me.id, sq: pd.sq });
        this.log(`🏠 ${me.name} comprou ${s.name} por $${s.price}.`);
        if (s.group && this.ownsGroup(me.id, s.group)) this.log(`⭐ ${me.name} completou o grupo ${s.group}! Aluguel dobrado.`);
        g.pending = null;
        this.after();
        return;
      }
      case 'pass': {
        const pd = g.pending;
        if (!pd || pd.type !== 'buy' || pd.pid !== me.id) return 'Nada para recusar.';
        this.log(`${me.name} não comprou ${BOARD[pd.sq].name}.`);
        g.pending = null;
        this.after();
        return;
      }
      case 'end': {
        if (!myTurn) return 'Não é sua vez.';
        if (g.turnPhase !== 'done') return 'Termine sua jogada primeiro.';
        if (myDebt) return 'Pague sua dívida antes de encerrar.';
        this.nextTurn();
        return;
      }
      case 'jailPay': {
        if (!myTurn || !me.inJail || g.turnPhase !== 'roll') return 'Agora não.';
        if (me.money < JAIL_FINE) return 'Dinheiro insuficiente para a fiança.';
        me.money -= JAIL_FINE;
        me.inJail = false; me.jailTries = 0;
        this.e({ k: 'money', pid: me.id, delta: -JAIL_FINE });
        this.e({ k: 'free', pid: me.id });
        this.log(`🔓 ${me.name} pagou $${JAIL_FINE} de fiança.`);
        return;
      }
      case 'jailCard': {
        if (!myTurn || !me.inJail || g.turnPhase !== 'roll') return 'Agora não.';
        if (me.jailCards < 1) return 'Você não tem carta de saída.';
        me.jailCards--;
        me.inJail = false; me.jailTries = 0;
        this.e({ k: 'free', pid: me.id });
        this.log(`🎫 ${me.name} usou a carta e saiu da prisão.`);
        return;
      }
      case 'build': return this.build(me, int(m.sq));
      case 'sell': return this.sell(me, int(m.sq));
      case 'mortgage': return this.mortgage(me, int(m.sq));
      case 'unmortgage': return this.unmortgage(me, int(m.sq));
      case 'payDebt': {
        if (!myDebt) return 'Você não tem dívidas.';
        if (me.money < myDebt.amount) return `Faltam $${myDebt.amount - me.money}. Venda casas ou hipoteque propriedades.`;
        me.money -= myDebt.amount;
        this.e({ k: 'money', pid: me.id, delta: -myDebt.amount });
        const to = myDebt.to && this.P(myDebt.to);
        if (to && !to.bankrupt) { to.money += myDebt.amount; this.e({ k: 'money', pid: to.id, delta: myDebt.amount }); }
        g.debts = g.debts.filter((d) => d !== myDebt);
        this.log(`✅ ${me.name} quitou a dívida de $${myDebt.amount}.`);
        return;
      }
      case 'bankrupt': {
        this.bankrupt(me);
        return;
      }
      case 'trade': {
        if (g.trade) return 'Já existe uma proposta de troca em andamento.';
        const to = this.P(m.to);
        if (!to || to.id === me.id || to.bankrupt) return 'Escolha um jogador válido.';
        const t = {
          id: uid(6), from: me.id, to: to.id,
          give: { props: [...new Set((m.give?.props || []).map(int))], money: int(m.give?.money) },
          get: { props: [...new Set((m.get?.props || []).map(int))], money: int(m.get?.money) },
        };
        if (!t.give.props.length && !t.get.props.length && !t.give.money && !t.get.money) return 'A proposta está vazia.';
        const e = this.tradeError(t);
        if (e) return e;
        g.trade = t;
        this.log(`🤝 ${me.name} fez uma proposta de troca para ${to.name}.`);
        this.e({ k: 'tradeOffer', from: me.id, to: to.id });
        return;
      }
      case 'tradeReply': {
        const t = g.trade;
        if (!t || t.to !== me.id) return 'Não há proposta para você.';
        const from = this.P(t.from);
        if (m.accept) {
          const e = this.tradeError(t);
          if (e) { g.trade = null; this.log(`Troca cancelada: ${e}`); return; }
          from.money += t.get.money - t.give.money;
          me.money += t.give.money - t.get.money;
          if (t.give.money || t.get.money) {
            this.e({ k: 'money', pid: from.id, delta: t.get.money - t.give.money });
            this.e({ k: 'money', pid: me.id, delta: t.give.money - t.get.money });
          }
          for (const i of t.give.props) g.props[i].owner = me.id;
          for (const i of t.get.props) g.props[i].owner = from.id;
          this.log(`🤝 ${me.name} aceitou a troca com ${from.name}!`);
          this.e({ k: 'tradeDone', a: from.id, b: me.id, sqs: [...t.give.props, ...t.get.props] });
        } else {
          this.log(`❌ ${me.name} recusou a troca de ${from.name}.`);
          this.e({ k: 'tradeNo', pid: me.id });
        }
        g.trade = null;
        return;
      }
      case 'tradeCancel': {
        if (!g.trade || g.trade.from !== me.id) return 'Nada para cancelar.';
        g.trade = null;
        this.log(`${me.name} cancelou a proposta de troca.`);
        return;
      }
      case 'skip': {
        const c = this.cur();
        if (me.id !== g.hostId) return 'Só o anfitrião pode pular a vez.';
        if (c.connected) return 'O jogador está online.';
        this.log(`⏭️ O anfitrião pulou a vez de ${c.name} (offline).`);
        if (g.debts.some((d) => d.pid === c.id)) { this.bankrupt(c); return; }
        if (g.trade && (g.trade.from === c.id || g.trade.to === c.id)) g.trade = null;
        this.nextTurn();
        return;
      }
    }
    return 'Ação desconhecida.';
  }

  join(ws, m) {
    const g = this.g;
    let p = m.token && g.players.find((x) => x.token === m.token);
    if (p) {
      if (!p.connected) this.log(`${p.name} voltou.`);
      p.connected = true;
    } else {
      if (g.phase !== 'lobby') { ws.serializeAttachment({ pid: null }); this.send(ws, { t: 'welcome', pid: null, spectator: true }); return; }
      if (g.players.length >= MAX_PLAYERS) return 'A sala está cheia (máximo 6 jogadores).';
      const used = g.players.map((x) => x.color);
      const color = PCOLORS.includes(m.color) && !used.includes(m.color) ? m.color : PCOLORS.find((c) => !used.includes(c));
      let name = clean(m.name) || 'Jogador';
      if (g.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = (name.slice(0, 13) + ' ' + (g.players.length + 1));
      p = {
        id: uid(8), token: crypto.randomUUID(), name, color,
        money: START_MONEY, pos: 0, inJail: false, jailTries: 0, jailCards: 0,
        bankrupt: false, connected: true,
      };
      g.players.push(p);
      if (!g.hostId || !this.P(g.hostId)) g.hostId = p.id;
      this.log(`👋 ${p.name} entrou na sala.`);
      this.e({ k: 'joined', pid: p.id });
    }
    ws.serializeAttachment({ pid: p.id });
    this.send(ws, { t: 'welcome', pid: p.id, token: p.token });
  }

  // --------------------------------------------------------------- turno
  roll(me) {
    const g = this.g;
    const d = [d6(), d6()];
    const total = d[0] + d[1];
    const dbl = d[0] === d[1];
    g.lastDice = d;
    this.e({ k: 'dice', pid: me.id, d });

    if (me.inJail) {
      g.rollAgain = false;
      if (dbl) {
        me.inJail = false; me.jailTries = 0;
        this.e({ k: 'free', pid: me.id });
        this.log(`🎲 ${me.name} tirou dupla (${d[0]}+${d[1]}) e saiu da prisão!`);
        this.move(me, total); this.land(me, total);
      } else {
        me.jailTries++;
        if (me.jailTries >= 3) {
          me.inJail = false; me.jailTries = 0;
          this.log(`${me.name} não tirou dupla pela 3ª vez e pagou $${JAIL_FINE} de fiança.`);
          this.charge(me, JAIL_FINE, null, 'fiança');
          this.e({ k: 'free', pid: me.id });
          this.move(me, total); this.land(me, total);
        } else {
          this.log(`🔒 ${me.name} tirou ${d[0]}+${d[1]} e continua preso (${me.jailTries}/3).`);
        }
      }
      this.after();
      return;
    }

    if (dbl) {
      g.doubles++;
      if (g.doubles >= 3) {
        this.log(`🚨 ${me.name} tirou 3 duplas seguidas e foi preso por excesso de velocidade!`);
        this.goToJail(me);
        this.after();
        return;
      }
      g.rollAgain = true;
      this.log(`🎲 ${me.name} tirou dupla ${d[0]}+${d[1]} — joga de novo!`);
    } else {
      g.rollAgain = false;
      this.log(`🎲 ${me.name} tirou ${d[0]}+${d[1]} = ${total}.`);
    }
    this.move(me, total);
    this.land(me, total);
    this.after();
  }

  after() {
    const g = this.g;
    if (g.phase !== 'playing') return;
    if (g.pending) { g.turnPhase = 'decide'; return; }
    const p = this.cur();
    g.turnPhase = g.rollAgain && !p.inJail && !p.bankrupt ? 'roll' : 'done';
  }

  nextTurn() {
    const g = this.g;
    g.rollAgain = false; g.doubles = 0; g.pending = null;
    const n = g.players.length;
    let i = g.turn;
    for (let k = 0; k < n; k++) {
      i = (i + 1) % n;
      if (i === 0) g.round++;
      if (!g.players[i].bankrupt) break;
    }
    g.turn = i;
    g.turnPhase = 'roll';
    this.e({ k: 'turn', pid: this.cur().id });
  }

  move(p, steps) {
    if (!steps) return;
    const from = p.pos;
    const to = (((from + steps) % 40) + 40) % 40;
    p.pos = to;
    this.e({ k: 'move', pid: p.id, from, to, steps });
    if (steps > 0 && to < from) {
      this.give(p, GO_SALARY);
      this.log(`💰 ${p.name} passou pela Partida e recebeu $${GO_SALARY}.`);
    }
  }

  moveTo(p, target) { this.move(p, (target - p.pos + 40) % 40); }

  goToJail(p) {
    const g = this.g;
    this.e({ k: 'move', pid: p.id, from: p.pos, to: 10, direct: true });
    p.pos = 10; p.inJail = true; p.jailTries = 0;
    g.rollAgain = false; g.doubles = 0;
    this.e({ k: 'jail', pid: p.id });
    this.log(`🚔 ${p.name} foi para a prisão!`);
  }

  give(p, amount) { p.money += amount; this.e({ k: 'money', pid: p.id, delta: amount }); }

  charge(p, amount, toId, reason) {
    if (amount <= 0) return;
    const to = toId ? this.P(toId) : null;
    if (p.money >= amount) {
      p.money -= amount;
      this.e({ k: 'money', pid: p.id, delta: -amount });
      if (to) { to.money += amount; this.e({ k: 'money', pid: to.id, delta: amount }); }
    } else {
      this.g.debts.push({ pid: p.id, amount, to: toId || null, reason });
      this.e({ k: 'debt', pid: p.id, amount });
      this.log(`⚠️ ${p.name} não tem dinheiro para pagar $${amount} (${reason}) e precisa levantar fundos!`);
    }
  }

  land(p, dice) {
    const g = this.g;
    const i = p.pos;
    const s = BOARD[i];
    if (isOwnable(s)) {
      const o = g.props[i];
      if (!o) { g.pending = { type: 'buy', sq: i, pid: p.id }; return; }
      if (o.owner === p.id) return;
      const owner = this.P(o.owner);
      if (!owner || owner.bankrupt) return;
      if (o.mortgaged) { this.log(`${s.name} está hipotecada — ${p.name} não paga aluguel.`); return; }
      const rent = this.rent(i, dice);
      this.log(`💸 ${p.name} caiu em ${s.name}: aluguel de $${rent} para ${owner.name}.`);
      this.e({ k: 'rent', pid: p.id, to: owner.id, sq: i, amount: rent });
      this.charge(p, rent, owner.id, `aluguel de ${s.name}`);
    } else if (s.type === 'tax') {
      this.log(`🧾 ${p.name} pagou ${s.name}: $${s.amount}.`);
      this.charge(p, s.amount, null, s.name);
    } else if (s.type === 'card') {
      this.drawCard(p, s.deck, dice);
    } else if (s.type === 'gotojail') {
      this.goToJail(p);
    }
  }

  rent(i, dice) {
    const g = this.g;
    const s = BOARD[i];
    const o = g.props[i];
    if (s.type === 'prop') {
      if (o.houses > 0) return s.rent[o.houses];
      return this.ownsGroup(o.owner, s.group) ? s.rent[0] * 2 : s.rent[0];
    }
    if (s.type === 'station') {
      const n = STATIONS.filter((j) => g.props[j]?.owner === o.owner).length;
      return 25 * 2 ** (n - 1);
    }
    const n = UTILS.filter((j) => g.props[j]?.owner === o.owner).length;
    return (n >= 2 ? 10 : 4) * (dice || 7);
  }

  drawCard(p, deck, dice) {
    const g = this.g;
    const order = g.decks[deck];
    const idx = order.shift();
    order.push(idx);
    const c = CARDS[deck][idx];
    this.e({ k: 'card', deck, text: c.text, pid: p.id });
    this.log(`${deck === 'sorte' ? '❓ Sorte' : '🎁 Surpresa'} — ${p.name}: ${c.text}`);
    const others = this.alive().filter((x) => x.id !== p.id);
    switch (c.a) {
      case 'money': if (c.v > 0) this.give(p, c.v); else this.charge(p, -c.v, null, 'carta'); break;
      case 'goto': this.moveTo(p, c.v); this.land(p, dice); break;
      case 'nearest': {
        let j = p.pos;
        do { j = (j + 1) % 40; } while (BOARD[j].type !== 'station');
        this.moveTo(p, j); this.land(p, dice); break;
      }
      case 'back': this.move(p, -c.v); this.land(p, dice); break;
      case 'jail': this.goToJail(p); break;
      case 'jailcard': p.jailCards++; break;
      case 'repairs': {
        let h = 0, ht = 0;
        for (const i of this.owned(p.id)) { const n = g.props[i].houses; if (n === 5) ht++; else h += n; }
        const amt = h * c.h + ht * c.ht;
        if (amt) this.charge(p, amt, null, 'reformas'); else this.log(`${p.name} não tem imóveis construídos. Ufa!`);
        break;
      }
      case 'payeach': for (const o of others) this.charge(p, c.v, o.id, 'carta'); break;
      case 'collecteach': for (const o of others) this.charge(o, c.v, p.id, 'carta'); break;
    }
  }

  // ---------------------------------------------------------- construção
  build(me, i) {
    const g = this.g;
    const s = BOARD[i];
    const o = g.props[i];
    if (!s || s.type !== 'prop' || !o || o.owner !== me.id) return 'Essa propriedade não é sua.';
    if (!this.ownsGroup(me.id, s.group)) return 'Você precisa ter todas as cidades da mesma cor.';
    const grp = GROUP[s.group];
    if (grp.some((j) => g.props[j].mortgaged)) return 'Há uma propriedade hipotecada neste grupo.';
    if (o.houses >= 5) return 'Já tem hotel aqui.';
    if (o.houses > Math.min(...grp.map((j) => g.props[j].houses))) return 'Construa de forma equilibrada: as outras cidades do grupo precisam de casas primeiro.';
    if (me.money < s.house) return 'Dinheiro insuficiente.';
    if (g.debts.some((d) => d.pid === me.id)) return 'Pague sua dívida primeiro.';
    me.money -= s.house;
    o.houses++;
    this.e({ k: 'money', pid: me.id, delta: -s.house });
    this.e({ k: 'build', pid: me.id, sq: i, houses: o.houses });
    this.log(o.houses === 5 ? `🏨 ${me.name} construiu um HOTEL em ${s.name}!` : `🏡 ${me.name} construiu uma casa em ${s.name} (${o.houses}).`);
  }

  sell(me, i) {
    const g = this.g;
    const s = BOARD[i];
    const o = g.props[i];
    if (!s || s.type !== 'prop' || !o || o.owner !== me.id) return 'Essa propriedade não é sua.';
    if (o.houses < 1) return 'Não há casas para vender.';
    const grp = GROUP[s.group];
    if (o.houses < Math.max(...grp.map((j) => g.props[j]?.houses || 0))) return 'Venda de forma equilibrada: comece pelas cidades com mais casas.';
    const val = Math.floor(s.house / 2);
    o.houses--;
    this.give(me, val);
    this.e({ k: 'build', pid: me.id, sq: i, houses: o.houses, sold: true });
    this.log(`${me.name} vendeu uma construção em ${s.name} por $${val}.`);
  }

  mortgage(me, i) {
    const g = this.g;
    const s = BOARD[i];
    const o = g.props[i];
    if (!s || !isOwnable(s) || !o || o.owner !== me.id) return 'Essa propriedade não é sua.';
    if (o.mortgaged) return 'Já está hipotecada.';
    if (this.groupHasHouses(i)) return 'Venda as casas do grupo antes de hipotecar.';
    const val = Math.floor(s.price / 2);
    o.mortgaged = true;
    this.give(me, val);
    this.e({ k: 'mortgage', sq: i });
    this.log(`🏦 ${me.name} hipotecou ${s.name} e recebeu $${val}.`);
  }

  unmortgage(me, i) {
    const g = this.g;
    const s = BOARD[i];
    const o = g.props[i];
    if (!s || !isOwnable(s) || !o || o.owner !== me.id) return 'Essa propriedade não é sua.';
    if (!o.mortgaged) return 'Não está hipotecada.';
    const cost = Math.ceil((s.price / 2) * 1.1);
    if (me.money < cost) return `Precisa de $${cost} para resgatar.`;
    me.money -= cost;
    o.mortgaged = false;
    this.e({ k: 'money', pid: me.id, delta: -cost });
    this.e({ k: 'mortgage', sq: i, off: true });
    this.log(`${me.name} resgatou a hipoteca de ${s.name} por $${cost}.`);
  }

  // --------------------------------------------------------------- trocas
  tradeError(t) {
    const g = this.g;
    const a = this.P(t.from), b = this.P(t.to);
    if (!a || !b || a.bankrupt || b.bankrupt) return 'Jogador inválido.';
    if (a.money < t.give.money) return `${a.name} não tem $${t.give.money}.`;
    if (b.money < t.get.money) return `${b.name} não tem $${t.get.money}.`;
    for (const [list, owner] of [[t.give.props, a], [t.get.props, b]]) {
      for (const i of list) {
        const s = BOARD[i];
        if (!s || !isOwnable(s) || g.props[i]?.owner !== owner.id) return `${s?.name || 'Casa'} não pertence a ${owner.name}.`;
        if (this.groupHasHouses(i)) return `Venda as casas do grupo de ${s.name} antes de trocar.`;
      }
    }
    return null;
  }

  // -------------------------------------------------------------- falência
  bankrupt(p) {
    const g = this.g;
    const debt = g.debts.find((d) => d.pid === p.id);
    const cred = debt?.to ? this.P(debt.to) : null;
    for (const i of this.owned(p.id)) {
      const o = g.props[i];
      if (o.houses) { p.money += o.houses * Math.floor(BOARD[i].house / 2); o.houses = 0; }
    }
    if (cred && !cred.bankrupt) {
      if (p.money > 0) { cred.money += p.money; this.e({ k: 'money', pid: cred.id, delta: p.money }); }
      for (const i of this.owned(p.id)) g.props[i].owner = cred.id;
      this.log(`💀 ${p.name} faliu! Tudo vai para ${cred.name}.`);
    } else {
      for (const i of this.owned(p.id)) delete g.props[i];
      this.log(`💀 ${p.name} faliu! As propriedades voltaram para o banco.`);
    }
    p.money = 0; p.bankrupt = true; p.inJail = false; p.jailCards = 0;
    g.debts = g.debts.filter((d) => d.pid !== p.id).map((d) => (d.to === p.id ? { ...d, to: null } : d));
    if (g.trade && (g.trade.from === p.id || g.trade.to === p.id)) g.trade = null;
    this.e({ k: 'bankrupt', pid: p.id });

    const alive = this.alive();
    if (alive.length <= 1) {
      g.phase = 'ended';
      g.winner = alive[0]?.id || null;
      g.pending = null;
      if (alive[0]) this.log(`🏆 ${alive[0].name} é o grande MAGNATA!`);
      this.e({ k: 'win', pid: g.winner });
      return;
    }
    if (this.cur().id === p.id) { g.pending = null; this.nextTurn(); }
  }
}
