'use strict';
/* Ядро игры "подкидной дурак" — серверная логика (Node, CommonJS).
   Та же логика, что прошла 40 автопартий в клиенте v1. */
const crypto = require('crypto');

const rank = c => c % 9;
const suit = c => Math.floor(c / 9);

function sha256hex(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }
function hmacSha256(key, msg){ return crypto.createHmac('sha256', key).update(msg).digest(); }

/* Детерминированная тасовка: цепочка HMAC-SHA256(seed, "swap:i") — идентична клиентской */
function deriveDeck(seedHex){
  const key = Buffer.from(seedHex, 'hex');
  const deck = [...Array(36).keys()];
  for (let i = 35; i > 0; i--){
    const h = hmacSha256(key, Buffer.from('swap:' + i));
    const j = h.readUInt32BE(0) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortHand(h, trump){
  h.sort((a,b) => ((suit(a)===trump?100:0)+suit(a)*10+rank(a)) - ((suit(b)===trump?100:0)+suit(b)*10+rank(b)));
}
function canBeat(d, a, trump){
  return (suit(d)===suit(a) && rank(d)>rank(a)) || (suit(d)===trump && suit(a)!==trump);
}
function cardCost(c, trump){ return (suit(c)===trump?20:0)+rank(c); }

function createGame(seedHex){
  const deck = deriveDeck(seedHex);
  const origDeck = deck.slice();
  const trump = suit(deck[0]);
  const hands = [[],[]];
  for (let i=0;i<6;i++){ hands[0].push(deck.pop()); hands[1].push(deck.pop()); }
  sortHand(hands[0], trump); sortHand(hands[1], trump);
  const lowT = h => { let m = 99; for (const c of h) if (suit(c)===trump && rank(c)<m) m = rank(c); return m; };
  return {
    seed: seedHex,
    commitment: sha256hex(Buffer.from(seedHex, 'hex')),
    origDeck, deck, trump, hands, table: [],
    attacker: lowT(hands[0]) < lowT(hands[1]) ? 0 : 1,
    phase: 'attack',   // 'attack' — ход атакующего (атака/подкидывание/«бито»), 'defend' — защита
    over: false, winner: null
  };
}

function validateAttack(g, p, cards){
  if (g.over) return 'game over';
  if (p !== g.attacker || g.phase !== 'attack') return 'not your turn';
  if (!Array.isArray(cards) || cards.length < 1) return 'no cards';
  const limit = Math.min(6, g.hands[1-g.attacker].length);
  if (g.table.length + cards.length > limit) return 'too many cards';
  for (const c of cards){
    if (!g.hands[p].includes(c)) return 'card not in hand';
  }
  if (g.table.length > 0){
    const ranks = new Set();
    for (const p2 of g.table){ ranks.add(rank(p2.a)); if (p2.d !== null) ranks.add(rank(p2.d)); }
    for (const c of cards) if (!ranks.has(rank(c))) return 'rank not on table';
  }
  return null;
}

function applyAttack(g, p, cards){
  for (const c of cards){
    g.hands[p].splice(g.hands[p].indexOf(c), 1);
    g.table.push({ a: c, d: null });
  }
  g.phase = 'defend';
}

function applyBeat(g, p, ti, card){
  if (g.over) return 'game over';
  const def = 1 - g.attacker;
  if (p !== def || g.phase !== 'defend') return 'not your turn';
  if (!Number.isInteger(ti) || ti < 0 || ti >= g.table.length || g.table[ti].d !== null) return 'bad target';
  if (!g.hands[p].includes(card)) return 'card not in hand';
  if (!canBeat(card, g.table[ti].a, g.trump)) return 'cannot beat';
  g.table[ti].d = card;
  g.hands[p].splice(g.hands[p].indexOf(card), 1);
  if (g.table.every(x => x.d !== null)) g.phase = 'attack'; // отбился — атакующий решает: подкинуть или бито
  return null;
}

function endBout(g, defended){
  const def = 1 - g.attacker;
  if (!defended){
    for (const p of g.table){ g.hands[def].push(p.a); if (p.d !== null) g.hands[def].push(p.d); }
    sortHand(g.hands[def], g.trump);
  }
  g.table = [];
  while (g.hands[g.attacker].length < 6 && g.deck.length) g.hands[g.attacker].push(g.deck.pop());
  while (g.hands[def].length < 6 && g.deck.length) g.hands[def].push(g.deck.pop());
  sortHand(g.hands[0], g.trump); sortHand(g.hands[1], g.trump);
  if (g.deck.length === 0){
    if (defended && g.hands[def].length === 0){ g.over = true; g.winner = def; return; }
    if (g.hands[g.attacker].length === 0){ g.over = true; g.winner = g.attacker; return; }
    g.attacker = 1 - g.attacker;
  }
  g.phase = 'attack';
}

function applyTake(g, p){
  if (g.over) return 'game over';
  if (p !== 1 - g.attacker || g.phase !== 'defend') return 'not your turn';
  endBout(g, false);
  return null;
}

function applyBito(g, p){
  if (g.over) return 'game over';
  if (p !== g.attacker || g.phase !== 'attack') return 'not your turn';
  if (g.table.length === 0) return 'nothing to beat';
  if (!g.table.every(x => x.d !== null)) return 'not all beaten';
  endBout(g, true);
  return null;
}

/* Хелперы для ИИ/автопилота */
function findBeating(hand, a, trump){
  let bi = -1, bc = 1e9;
  for (let i=0;i<hand.length;i++){
    if (canBeat(hand[i], a, trump)){
      const c = cardCost(hand[i], trump);
      if (c < bc){ bc = c; bi = i; }
    }
  }
  return bi;
}
function lowestIdx(hand, trump){
  let bi = 0, bc = 1e9;
  for (let i=0;i<hand.length;i++){
    const c = cardCost(hand[i], trump);
    if (c < bc){ bc = c; bi = i; }
  }
  return bi;
}

module.exports = { rank, suit, sha256hex, hmacSha256, deriveDeck, createGame,
  validateAttack, applyAttack, applyBeat, applyTake, applyBito, endBout,
  canBeat, cardCost, findBeating, lowestIdx, sortHand };
