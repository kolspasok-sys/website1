'use strict';
/* Космический Дурак — сервер (нулевые зависимости: node server.js)
   - WebSocket (RFC6455) минимальная реализация
   - Аккаунты (соль + SHA-256), балансы в data.json
   - Столы с кодом, ставки до 500, комиссия 20% банка
   - Контроль честности: коммитмент SHA-256(seed) до игры, раскрытие seed+колода после
   - Сервер держит колоду и руки: клиентам не передаются чужие карты
*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gc = require('./gamecore.js');

const PORT = process.env.PORT || 8080;
const TURN_TIMEOUT = 45000;    // мс на ход
const GRACE_PERIOD = 90000;    // мс на переподключение при обрыве
const MAX_STAKE = 500, MIN_STAKE = 10;

/* ---------- хранилище ---------- */
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
function save(){ fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
function getUser(name){ return db.users[name]; }

/* ---------- WebSocket (минимум RFC6455) ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key){
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
class WSConn {
  constructor(socket){
    this.s = socket; this.buf = Buffer.alloc(0); this.alive = true;
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
    socket.on('close', () => { if (this.alive){ this.alive = false; this.onclose && this.onclose(); } });
    socket.on('error', () => {});
  }
  _drain(){
    while (true){
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126){ if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (masked){
        const m = this.buf.slice(maskOff, maskOff + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      }
      this.buf = this.buf.slice(off + len);
      if (op === 0x8){ this.close(); return; }
      else if (op === 0x9){ this._send(0xA, payload); }
      else if (op === 0x1 && fin){
        if (payload.length < 65536 && this.onmessage) this.onmessage(payload.toString('utf8'));
      }
    }
  }
  _send(op, payload){
    if (!this.alive) return;
    const len = payload.length;
    let head;
    if (len < 126){ head = Buffer.from([0x80 | op, len]); }
    else if (len < 65536){ head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.s.write(Buffer.concat([head, payload])); } catch (e) {}
  }
  send(obj){ this._send(0x1, Buffer.from(JSON.stringify(obj))); }
  close(){
    if (!this.alive) return;
    this.alive = false;
    try { this._send(0x8, Buffer.alloc(0)); this.s.end(); } catch (e) {}
  }
}

/* ---------- столы ---------- */
const rooms = new Map(); // code -> room
function newCode(){
  let c;
  do { c = 'GX-' + Math.floor(1000 + Math.random() * 9000); } while (rooms.has(c));
  return c;
}
function broadcast(room, obj){ for (const p of room.players) if (p) p.conn.send(obj); }
function sendPlayer(room, i, obj){ if (room.players[i]) room.players[i].conn.send(obj); }

function stateMsg(room, you){
  const g = room.game;
  const opp = 1 - you;
  return {
    t: 'state', you, turn: g.attacker, await: g.phase,
    trump: g.trump, trumpCard: g.origDeck[0], deckCount: g.deck.length,
    table: g.table, counts: [g.hands[0].length, g.hands[1].length],
    hand: g.hands[you].slice(),
    stake: room.stake,
    balances: [room.players[0].user.balance, room.players[1].user.balance],
    names: [room.players[0].user.name, room.players[1].user.name]
  };
}
function sendState(room){
  for (const i of [0, 1]) if (room.players[i]) sendPlayer(room, i, stateMsg(room, i));
  resetTurnTimer(room);
}
function resetTurnTimer(room){
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.game && !room.game.over && room.status === 'playing'){
    room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_TIMEOUT);
  }
}

function startGame(room){
  const stake = room.stake;
  for (const p of room.players){
    if (p.user.balance < stake){ broadcast(room, { t: 'error', msg: 'Недостаточно очков у ' + p.user.name }); return; }
  }
  for (const p of room.players){ p.user.balance -= stake; }
  save();
  const seed = crypto.randomBytes(32).toString('hex');
  room.game = gc.createGame(seed);
  room.status = 'playing';
  room.again = [false, false];
  for (const i of [0, 1]){
    sendPlayer(room, i, {
      t: 'start', you: i, commitment: room.game.commitment,
      trump: room.game.trump, trumpCard: room.game.origDeck[0],
      hand: room.game.hands[i].slice(),
      oppName: room.players[1 - i].user.name,
      stake, balances: [room.players[0].user.balance, room.players[1].user.balance],
      names: [room.players[0].user.name, room.players[1].user.name]
    });
  }
  sendState(room);
}

function settle(room, winnerIdx, reason){
  const g = room.game;
  const bank = room.stake * 2;
  const comm = Math.floor(bank * 0.2);
  const payout = bank - comm;
  g.over = true; g.winner = winnerIdx;
  room.players[winnerIdx].user.balance += payout;
  room.players[winnerIdx].user.wins = (room.players[winnerIdx].user.wins || 0) + 1;
  room.players[1 - winnerIdx].user.losses = (room.players[1 - winnerIdx].user.losses || 0) + 1;
  save();
  if (room.turnTimer){ clearTimeout(room.turnTimer); room.turnTimer = null; }
  broadcast(room, {
    t: 'over', winner: winnerIdx, reason: reason || 'normal',
    bank, commission: comm, payout,
    balances: [room.players[0].user.balance, room.players[1].user.balance],
    seed: g.seed, deck: g.origDeck, commitment: g.commitment, trumpCard: g.origDeck[0]
  });
  room.status = 'over';
}

function afterAction(room, err){
  if (err){
    // не пересылаем ошибку всем — пришлём тому, кто ходил, по контексту нельзя, поэтому state подтвердит
  }
  const g = room.game;
  if (g.over){ settle(room, g.winner, 'normal'); return; }
  sendState(room);
}

function onTurnTimeout(room){
  const g = room.game;
  if (!g || g.over || room.status !== 'playing') return;
  if (g.phase === 'defend'){ gc.applyTake(g, 1 - g.attacker); }
  else {
    if (g.table.length === 0){
      const i = gc.lowestIdx(g.hands[g.attacker], g.trump);
      gc.applyAttack(g, g.attacker, [g.hands[g.attacker][i]]);
    } else if (g.table.every(x => x.d !== null)) gc.applyBito(g, g.attacker);
  }
  afterAction(room, null);
}

function leaveRoom(session, silent){
  const room = session.room;
  if (!room) return;
  const idx = room.players.indexOf(session);
  if (room.status === 'playing' && !room.game.over){
    // таймер на форфит
    room.disconnectTimer = setTimeout(() => {
      if (room.status === 'playing'){
        const winner = idx === 0 ? 1 : 0;
        // проигравшему возвращаем 0 — форфит = проигрыш ставки
        settle(room, winner, 'forfeit');
      }
    }, GRACE_PERIOD);
    broadcast(room, { t: 'notice', msg: 'Игрок отключился. Форфит через ' + (GRACE_PERIOD / 1000) + ' сек, если не вернётся.' });
    room.players[idx] = null;
  } else {
    broadcast(room, { t: 'notice', msg: 'Игрок покинул стол' });
    rooms.delete(room.code);
  }
  session.room = null;
}

/* ---------- обработка сообщений ---------- */
const sessions = new Set();
function handleMessage(session, m){
  const u = session.user;
  switch (m.t){
    case 'reg': {
      const name = String(m.u || '').trim(), pass = String(m.p || '');
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return session.conn.send({ t: 'error', msg: 'Логин: 3-20 символов (латиница, цифры, _)' });
      if (pass.length < 4) return session.conn.send({ t: 'error', msg: 'Пароль минимум 4 символа' });
      if (db.users[name]) return session.conn.send({ t: 'error', msg: 'Такой логин занят' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[name] = { salt, hash: gc.sha256hex(Buffer.from(salt + pass)), balance: 1000, wins: 0, losses: 0 };
      save();
      session.user = db.users[name]; session.name = name;
      session.conn.send({ t: 'auth_ok', name, balance: 1000 });
      break;
    }
    case 'auth': {
      const name = String(m.u || '').trim(), pass = String(m.p || '');
      const rec = db.users[name];
      if (!rec || rec.hash !== gc.sha256hex(Buffer.from(rec.salt + pass)))
        return session.conn.send({ t: 'error', msg: 'Неверный логин или пароль' });
      for (const s of sessions) if (s !== session && s.name === name){ s.conn.send({ t: 'error', msg: 'Вход с другого устройства' }); s.conn.close(); }
      session.user = rec; session.name = name;
      session.conn.send({ t: 'auth_ok', name, balance: rec.balance, wins: rec.wins || 0, losses: rec.losses || 0 });
      break;
    }
    case 'create': {
      if (!u) return;
      if (session.room) leaveRoom(session, true);
      const code = newCode();
      const room = { code, players: [session, null], stake: 100, status: 'lobby', game: null, turnTimer: null, again: [false, false] };
      rooms.set(code, room);
      session.room = room;
      session.conn.send({ t: 'room', code, role: 'host', stake: 100 });
      break;
    }
    case 'join': {
      if (!u) return;
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return session.conn.send({ t: 'error', msg: 'Стол не найден' });
      if (room.status !== 'lobby') return session.conn.send({ t: 'error', msg: 'Стол уже занят' });
      if (session.room) leaveRoom(session, true);
      room.players[1] = session;
      session.room = room;
      session.conn.send({ t: 'room', code: room.code, role: 'guest', stake: room.stake });
      sendPlayer(room, 0, { t: 'joined', name: u.name });
      break;
    }
    case 'stake': {
      const room = session.room;
      if (!room || room.status !== 'lobby') return;
      if (room.players[0] !== session) return session.conn.send({ t: 'error', msg: 'Ставку задаёт хозяин стола' });
      const a = parseInt(m.amount, 10);
      if (!(a >= MIN_STAKE && a <= MAX_STAKE)) return session.conn.send({ t: 'error', msg: 'Ставка от ' + MIN_STAKE + ' до ' + MAX_STAKE });
      room.stake = a;
      room.again = [false, false];
      broadcast(room, { t: 'stake', amount: a });
      break;
    }
    case 'ready': {
      const room = session.room;
      if (!room) return;
      const idx = room.players.indexOf(session);
      if (idx < 0) return;
      if (room.status === 'lobby'){ room.again[idx] = true; if (room.players[0] && room.players[1] && room.again[0] && room.again[1]){ room.again = [false, false]; startGame(room); } }
      else if (room.status === 'over'){ room.again[idx] = true; if (room.players[0] && room.players[1] && room.again[0] && room.again[1]){ room.again = [false, false]; startGame(room); } }
      break;
    }
    case 'attack': {
      const room = session.room;
      if (!room || room.status !== 'playing') return;
      const idx = room.players.indexOf(session);
      const err = gc.validateAttack(room.game, idx, m.cards);
      if (err) return session.conn.send({ t: 'error', msg: err });
      gc.applyAttack(room.game, idx, m.cards);
      afterAction(room, null);
      break;
    }
    case 'beat': {
      const room = session.room;
      if (!room || room.status !== 'playing') return;
      const idx = room.players.indexOf(session);
      const err = gc.applyBeat(room.game, idx, m.i, m.card);
      if (err) return session.conn.send({ t: 'error', msg: err });
      afterAction(room, null);
      break;
    }
    case 'take': {
      const room = session.room;
      if (!room || room.status !== 'playing') return;
      const idx = room.players.indexOf(session);
      const err = gc.applyTake(room.game, idx);
      if (err) return session.conn.send({ t: 'error', msg: err });
      afterAction(room, null);
      break;
    }
    case 'bito': {
      const room = session.room;
      if (!room || room.status !== 'playing') return;
      const idx = room.players.indexOf(session);
      const err = gc.applyBito(room.game, idx);
      if (err) return session.conn.send({ t: 'error', msg: err });
      afterAction(room, null);
      break;
    }
    case 'leave': leaveRoom(session); break;
  }
}

/* ---------- HTTP + upgrade ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html'){
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
      if (e){ res.writeHead(404); res.end('client not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  } else { res.writeHead(404); res.end(); }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  const conn = new WSConn(socket);
  const session = { conn, user: null, name: null, room: null };
  sessions.add(session);
  conn.onmessage = txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    try { handleMessage(session, m); } catch (e) { console.error('handler error', e); }
  };
  conn.onclose = () => {
    sessions.delete(session);
    if (session.room) leaveRoom(session);
  };
  conn.send({ t: 'hello', server: 'durak-space/1.0' });
});

server.listen(PORT, () => {
  console.log('🚀 Космический Дурак сервер: http://localhost:' + PORT);
  console.log('   Клиент раздаётся с этого же адреса (открой в двух вкладках/браузерах)');
});
