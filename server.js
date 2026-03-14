const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://robcleaton.github.io', 'https://shithead.warface.co.uk', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  DATA
// ─────────────────────────────────────────────────────────────
const SUITS  = ['♠','♥','♦','♣'];
const VALUES = [2,3,4,5,6,7,8,9,10,11,12,13,14];
const NAMES  = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};

const rooms = new Map(); // code → Room

// ─────────────────────────────────────────────────────────────
//  DECK UTILITIES
// ─────────────────────────────────────────────────────────────
function makeDeck() {
  let id = 0;
  return SUITS.flatMap(suit => VALUES.map(value => ({ suit, value, id: id++ })));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RUDE_WORDS = [
  'ARSE','ARSEHOLE','BASTARD','BELLEND','BITCH','BLOODY','BOLLOCKS','BONK',
  'BUGGER','BUMHOLE','CLUNGE','COB','COCK','COCKUP','COD','CRAP','CRUD',
  'CUNT','DICKHEAD','DIPSTICK','DUFFER','DUNCE','FANNY','FART','FATARSE',
  'FILTH','FLANGE','FLANKER','FLAPS','FRIG','FUCK','FUCKER','FUCKUP',
  'GIT','GOBSHITE','GROTTY','GUFF','HELL','HOOKER','JACKASS','JOBBY',
  'KNOB','KNOBBER','KNOBEND','LARD','MINGE','MINGER','MUPPET','NONCE',
  'NUMPTY','PANTS','PILLOCK','PISS','PISSED','PLONKER','PRAT','PRICK',
  'PRUDE','PUBE','SHIT','SHITE','SHITHEAD','SKANK','SLAG','SLAPPER',
  'SLOB','SNOG','SNOTTY','SOD','SPUNK','TART','THICK','TITS','TOSSER',
  'TURD','TWAT','TWIT','WANK','WANKER','WAZZOCK','WHORE','WILLY',
];

function generateCode() {
  let code;
  do {
    code = RUDE_WORDS[Math.floor(Math.random() * RUDE_WORDS.length)];
  } while (rooms.has(code));
  return code;
}

// ─────────────────────────────────────────────────────────────
//  GAME LOGIC
// ─────────────────────────────────────────────────────────────
function effectiveTop(gs) {
  // 8 is a window — skip 8s from the top to find the card below
  for (let i = gs.pile.length - 1; i >= 0; i--) {
    if (gs.pile[i].value !== 8) return gs.pile[i];
  }
  return null;
}

function canPlay(gs, card) {
  if (gs.threeOn) return card.value === 3;
  if (card.value === 3)  return true;   // 3 plays on anything
  if (card.value === 8)  return true;   // 8 (window) plays on anything
  const top = effectiveTop(gs);
  if (card.value === 7)  return !top || top.value !== 3;  // 7 plays on anything except a 3
  if (card.value === 2)  return true;
  if (card.value === 10) return true;
  if (!top)              return true;
  if (gs.sevenOn) return card.value <= 7;
  return card.value >= top.value;
}

function fourOfAKindOnPile(gs) {
  if (gs.pile.length < 4) return false;
  const top = gs.pile[gs.pile.length - 1].value;
  let n = 0;
  for (let i = gs.pile.length - 1; i >= 0; i--) {
    if (gs.pile[i].value === top) n++;
    else break;
  }
  return n >= 4;
}

function burnPile(gs) {
  gs.burned.push(...gs.pile);
  gs.pile = [];
  gs.sevenOn = false;
  gs.threeOn = false;
}

function drawUp(gs, pidx) {
  const p = gs.players[pidx];
  while (p.hand.length < 3 && gs.deck.length > 0) {
    p.hand.push(gs.deck.shift());
  }
}

function playerPhase(gs, pidx) {
  const p = gs.players[pidx];
  if (p.hand.length > 0)   return 'hand';
  if (p.faceUp.length > 0) return 'faceUp';
  return 'faceDown';
}

function isGameOver(gs, pidx) {
  const p = gs.players[pidx];
  return p.hand.length === 0 && p.faceUp.length === 0 && p.faceDown.length === 0;
}

function dealCards(room) {
  const gs = room.state;
  const deck = shuffle(makeDeck());
  let di = 0;

  gs.deck = deck;
  gs.pile = [];
  gs.burned = [];
  gs.sevenOn = false;
  gs.threeOn = false;
  gs.winner = null;
  gs.log = [];
  gs.msg = 'Swap cards between your hand and face-up slots, then click Ready.';

  for (const p of gs.players) {
    p.faceDown = deck.slice(di, di + 3); di += 3;
    p.faceUp   = deck.slice(di, di + 3); di += 3;
    p.hand     = deck.slice(di, di + 3); di += 3;
    p.ready    = false;
  }

  gs.deck = deck.slice(di);
}

function doPlay(room, pidx, cardIds, source) {
  const gs = room.state;
  const p = gs.players[pidx];
  let cards;

  if (source === 'hand') {
    cards = cardIds.map(id => p.hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Invalid card IDs' };
    p.hand = p.hand.filter(c => !cardIds.includes(c.id));
  } else if (source === 'faceUp') {
    cards = cardIds.map(id => p.faceUp.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Invalid card IDs' };
    p.faceUp = p.faceUp.filter(c => !cardIds.includes(c.id));
  } else {
    // faceDown: cardIds is [index]
    const idx = cardIds[0];
    if (idx < 0 || idx >= p.faceDown.length) return { error: 'Invalid face-down index' };
    cards = [p.faceDown.splice(idx, 1)[0]];
  }

  const label = cards.map(c => NAMES[c.value] + c.suit).join('+');
  gs.pile.push(...cards);

  let playAgain = false;
  let extraMsg = '';

  if (cards.some(c => c.value === 10)) {
    burnPile(gs);
    playAgain = true;
    extraMsg = '🔥 BURN! Play again.';
  } else if (fourOfAKindOnPile(gs)) {
    burnPile(gs);
    playAgain = true;
    extraMsg = '🔥 FOUR OF A KIND — BURN! Play again.';
  } else if (cards.some(c => c.value === 2)) {
    gs.sevenOn = false;
    gs.threeOn = false;
    playAgain = true;
    extraMsg = '✨ Wild reset! Play again.';
  } else if (cards.some(c => c.value === 8)) {
    gs.sevenOn = false;
    gs.threeOn = false;
    extraMsg = '👁 Window! Next player plays on the card below.';
  } else if (cards.some(c => c.value === 3)) {
    gs.threeOn = true;
    gs.sevenOn = false;
    extraMsg = '⚠ Next player must play a 3 or pick up!';
  } else if (cards.some(c => c.value === 7)) {
    gs.sevenOn = true;
    gs.threeOn = false;
    extraMsg = '⚠ Next player must play 7 or lower!';
  } else {
    gs.sevenOn = false;
    gs.threeOn = false;
  }

  if (source === 'hand') drawUp(gs, pidx);

  addLog(gs, `${p.name} plays ${label}. ${extraMsg}`);

  if (isGameOver(gs, pidx)) {
    gs.phase = 'gameover';
    gs.winner = pidx;
    gs.msg = `${p.name} wins!`;
    broadcastState(room);
    return { ok: true };
  }

  if (playAgain) {
    gs.msg = `${p.name} plays again! ${extraMsg}`;
  } else {
    advanceTurn(room);
    return { ok: true };
  }

  broadcastState(room);
  return { ok: true };
}

function burnTopThrees(gs) {
  // Find where the run of 3s at the top of the pile starts
  let splitIdx = gs.pile.length;
  for (let i = gs.pile.length - 1; i >= 0; i--) {
    if (gs.pile[i].value === 3) splitIdx = i;
    else break;
  }
  const threes = gs.pile.splice(splitIdx);
  gs.burned.push(...threes);
  return threes.length;
}

function doPickUp(room, pidx) {
  const gs = room.state;
  const p = gs.players[pidx];
  if (gs.threeOn) {
    const burned = burnTopThrees(gs);
    addLog(gs, `${p.name} picks up the pile (${gs.pile.length} cards). ${burned} 3${burned !== 1 ? 's' : ''} burned.`);
  } else {
    addLog(gs, `${p.name} picks up the pile (${gs.pile.length} cards).`);
  }
  p.hand.push(...gs.pile);
  gs.pile = [];
  gs.sevenOn = false;
  gs.threeOn = false;
  advanceTurn(room);
}

function advanceTurn(room) {
  const gs = room.state;
  gs.current = (gs.current + 1) % gs.players.length;
  const p = gs.players[gs.current];
  const phase = playerPhase(gs, gs.current);

  const topCard = gs.pile.length ? gs.pile[gs.pile.length - 1] : null;
  const eightOn = topCard && topCard.value === 8;
  const effective = effectiveTop(gs);

  if (phase === 'faceDown') {
    gs.msg = `${p.name}'s turn — flip a face-down card!`;
  } else if (gs.threeOn) {
    gs.msg = `${p.name}'s turn — must play a 3 or pick up!`;
  } else if (gs.sevenOn) {
    gs.msg = `${p.name}'s turn — must play 7 or lower!`;
  } else if (eightOn) {
    const cardStr = effective ? `${NAMES[effective.value]}${effective.suit}` : 'anything';
    gs.msg = `${p.name}'s turn — playing on ${cardStr}`;
  } else {
    gs.msg = `${p.name}'s turn.`;
  }

  broadcastState(room);
}

function addLog(gs, line) {
  gs.log.push(line);
  if (gs.log.length > 50) gs.log.shift();
}

// ─────────────────────────────────────────────────────────────
//  STATE VIEW (personalised per player)
// ─────────────────────────────────────────────────────────────
function stateView(room, pidx) {
  const gs = room.state;
  const me = gs.players[pidx];
  const hostSeatIndex = room.players.findIndex(rp => rp.playerId === room.hostId);
  const allReady = gs.players.every(p => p.ready);

  const opponents = gs.players
    .map((p, i) => {
      if (i === pidx) return null;
      const rp = room.players[i] || {};
      return {
        name: p.name,
        handCount: p.hand.length,
        faceUp: gs.phase === 'setup' ? p.faceUp.map(() => null) : p.faceUp,
        faceDownCount: p.faceDown.length,
        connected: rp.connected !== false,
        ready: p.ready,
        seatIndex: i,
      };
    })
    .filter(Boolean);

  return {
    seatIndex: pidx,
    myHand: me.hand,
    myFaceUp: me.faceUp,
    myFaceDown: me.faceDown.map(() => null), // always hidden — face-down cards are never revealed to client
    myFaceDownCount: me.faceDown.length,
    myReady: me.ready,
    opponents,
    phase: gs.phase,
    current: gs.current,
    pile: gs.pile,
    deckCount: gs.deck.length,
    burnCount: gs.burned.length,
    sevenOn: gs.sevenOn,
    threeOn: gs.threeOn,
    msg: gs.msg,
    log: gs.log.slice(-8),
    winner: gs.winner,
    roomCode: room.code,
    hostSeatIndex,
    allReady,
    playerCount: gs.players.length,
    deckStyle: gs.deckStyle || 'a',
  };
}

function broadcastState(room) {
  const gs = room.state;
  if (!gs) return;
  gs.players.forEach((_, pidx) => {
    const rp = room.players[pidx];
    if (rp && rp.connected !== false && !rp.permanentlyLeft) {
      io.to(rp.id).emit('stateUpdate', stateView(room, pidx));
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let currentRoom = null;
  let seatIndex = null;

  socket.on('createRoom', ({ name, playerId }) => {
    if (!name || typeof name !== 'string') return;
    const playerName = name.trim().slice(0, 20) || 'Player';
    const code = generateCode();

    const room = {
      code,
      hostId: playerId || socket.id,
      players: [{ id: socket.id, playerId: playerId || socket.id, name: playerName, connected: true }],
      state: {
        deck: [], pile: [], burned: [], sevenOn: false, threeOn: false,
        winner: null, phase: 'lobby', current: 0, msg: '', log: [],
        players: [{ name: playerName, hand: [], faceUp: [], faceDown: [], ready: false }],
      },
      createdAt: Date.now(),
      cleanupTimers: {},
    };

    rooms.set(code, room);
    socket.join(code);
    currentRoom = room;
    seatIndex = 0;

    socket.emit('stateUpdate', stateView(room, 0));
  });

  socket.on('joinRoom', ({ code, name, playerId }) => {
    if (!code || !name) return;
    const roomCode = code.trim().toUpperCase();
    const playerName = name.trim().slice(0, 20) || 'Player';
    const room = rooms.get(roomCode);

    if (!room) { socket.emit('joinError', 'Room not found.'); return; }
    if (room.state.phase !== 'lobby') { socket.emit('joinError', 'Game already in progress.'); return; }
    if (room.players.length >= 4) { socket.emit('joinError', 'Room is full (max 4 players).'); return; }

    const pidx = room.players.length;
    room.players.push({ id: socket.id, playerId: playerId || socket.id, name: playerName, connected: true });
    room.state.players.push({ name: playerName, hand: [], faceUp: [], faceDown: [], ready: false });

    socket.join(roomCode);
    currentRoom = room;
    seatIndex = pidx;

    broadcastState(room);
  });

  socket.on('rejoinRoom', ({ playerId, roomCode }) => {
    if (!playerId || !roomCode) return;
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) { socket.emit('reconnectFailed', 'Room no longer exists.'); return; }

    const pidx = room.players.findIndex(p => p.playerId === playerId);
    if (pidx === -1) { socket.emit('reconnectFailed', 'Not found in room.'); return; }
    if (room.players[pidx].permanentlyLeft) { socket.emit('reconnectFailed', 'You left this game.'); return; }

    // Cancel pending cleanup timer for this seat
    if (room.cleanupTimers[pidx]) {
      clearTimeout(room.cleanupTimers[pidx]);
      delete room.cleanupTimers[pidx];
    }

    room.players[pidx].id = socket.id;
    room.players[pidx].connected = true;
    socket.join(roomCode.toUpperCase());
    currentRoom = room;
    seatIndex = pidx;

    const gs = room.state;
    if (gs.phase === 'playing' || gs.phase === 'gameover') {
      addLog(gs, `${gs.players[pidx].name} reconnected.`);
      if (gs.phase === 'playing') gs.msg = `${gs.players[pidx].name} reconnected.`;
    }

    broadcastState(room);
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const hostPlayer = currentRoom.players.find(p => p.playerId === currentRoom.hostId);
    if (!hostPlayer || hostPlayer.id !== socket.id) return;
    const room = currentRoom;
    if (room.state.phase !== 'lobby') return;
    if (room.players.length < 2) {
      socket.emit('joinError', 'Need at least 2 players to start.');
      return;
    }

    room.state.phase = 'deckSelect';
    room.state.deckStyle = 'a';
    broadcastState(room);
  });

  socket.on('selectDeck', ({ deckStyle }) => {
    if (!currentRoom) return;
    const hostPlayer = currentRoom.players.find(p => p.playerId === currentRoom.hostId);
    if (!hostPlayer || hostPlayer.id !== socket.id) return;
    const room = currentRoom;
    if (room.state.phase !== 'deckSelect') return;
    room.state.deckStyle = ['a', 'b', 'c'].includes(deckStyle) ? deckStyle : 'a';
    room.state.phase = 'setup';
    dealCards(room);
    broadcastState(room);
  });

  socket.on('swapCards', ({ handCardId, faceUpCardId }) => {
    if (!currentRoom || seatIndex === null) return;
    const gs = currentRoom.state;
    if (gs.phase !== 'setup') return;

    const p = gs.players[seatIndex];
    const hIdx = p.hand.findIndex(c => c.id === handCardId);
    const fIdx = p.faceUp.findIndex(c => c.id === faceUpCardId);
    if (hIdx === -1 || fIdx === -1) return;

    [p.hand[hIdx], p.faceUp[fIdx]] = [p.faceUp[fIdx], p.hand[hIdx]];
    broadcastState(currentRoom);
  });

  socket.on('playerReady', () => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const gs = room.state;
    if (gs.phase !== 'setup') return;

    gs.players[seatIndex].ready = true;
    addLog(gs, `${gs.players[seatIndex].name} is ready.`);

    const allReady = gs.players.every(p => p.ready);
    if (allReady) {
      gs.phase = 'playing';
      gs.current = Math.floor(Math.random() * gs.players.length);
      const first = gs.players[gs.current];
      gs.msg = `${first.name} goes first!`;
      addLog(gs, `--- Game started. ${first.name} goes first. ---`);
    }

    broadcastState(room);
  });

  socket.on('play', ({ cardIds, source }) => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const gs = room.state;

    if (gs.phase !== 'playing') return;
    if (gs.current !== seatIndex) {
      socket.emit('playError', "It's not your turn.");
      return;
    }
    if (!Array.isArray(cardIds) || cardIds.length === 0) return;

    const p = gs.players[seatIndex];
    const phase = playerPhase(gs, seatIndex);

    // Validate source matches current phase
    if (source !== phase) {
      socket.emit('playError', `You must play from your ${phase}.`);
      return;
    }

    // Validate all cards same value (except faceDown)
    if (source !== 'faceDown') {
      const pool = source === 'hand' ? p.hand : p.faceUp;
      const cards = cardIds.map(id => pool.find(c => c.id === id)).filter(Boolean);
      if (cards.length !== cardIds.length) {
        socket.emit('playError', 'Invalid cards.');
        return;
      }
      if (cards.length > 1 && !cards.every(c => c.value === cards[0].value)) {
        socket.emit('playError', 'All played cards must have the same value.');
        return;
      }
      if (!canPlay(gs, cards[0])) {
        const top = effectiveTop(gs);
        const msg = gs.threeOn
          ? "Can't play that — you must play a 3!"
          : gs.sevenOn
            ? "Can't play that — must play 7 or lower."
            : `Can't play that — must match or beat ${top ? NAMES[top.value] : 'anything'}.`;
        socket.emit('playError', msg);
        return;
      }
    }

    doPlay(room, seatIndex, cardIds, source);
  });

  socket.on('pickUp', () => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const gs = room.state;

    if (gs.phase !== 'playing') return;
    if (gs.current !== seatIndex) return;
    if (gs.pile.length === 0) return;

    doPickUp(room, seatIndex);
  });

  socket.on('flipFaceDown', ({ index }) => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const gs = room.state;

    if (gs.phase !== 'playing') return;
    if (gs.current !== seatIndex) return;
    if (playerPhase(gs, seatIndex) !== 'faceDown') return;

    const p = gs.players[seatIndex];
    if (index < 0 || index >= p.faceDown.length) return;

    const card = p.faceDown[index];
    if (canPlay(gs, card)) {
      addLog(gs, `${p.name} flips ${NAMES[card.value]}${card.suit} — valid!`);
      doPlay(room, seatIndex, [index], 'faceDown');
    } else {
      p.faceDown.splice(index, 1);
      if (gs.threeOn) burnTopThrees(gs);
      addLog(gs, `${p.name} flips ${NAMES[card.value]}${card.suit} — can't play it, picks up the pile!`);
      p.hand.push(card, ...gs.pile);
      gs.pile = [];
      gs.sevenOn = false;
      gs.threeOn = false;
      gs.msg = `${p.name} flipped ${NAMES[card.value]}${card.suit} — invalid! Pile added to hand.`;
      broadcastState(room);
      setTimeout(() => {
        advanceTurn(room);
      }, 800);
    }
  });

  socket.on('restartGame', () => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const gs = room.state;
    if (gs.phase !== 'gameover') return;

    gs.phase = 'setup';
    gs.winner = null;
    dealCards(room);
    broadcastState(room);
  });

  socket.on('cursorMove', ({ x, y }) => {
    if (!currentRoom || seatIndex === null) return;
    if (currentRoom.state.phase !== 'lobby') return;
    const name = currentRoom.state.players[seatIndex]?.name || 'Player';
    socket.to(currentRoom.code).emit('cursorUpdate', { seatIndex, x, y, name });
  });

  socket.on('leaveRoom', () => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const rp = room.players[seatIndex];
    if (rp) {
      rp.connected = false;
      rp.permanentlyLeft = true;
    }
    const gs = room.state;
    if (gs && (gs.phase === 'playing' || gs.phase === 'setup')) {
      addLog(gs, `${gs.players[seatIndex].name} left the game.`);
      gs.msg = `${gs.players[seatIndex].name} left the game.`;
      broadcastState(room);
    } else if (gs && gs.phase === 'lobby') {
      broadcastState(room);
    }
    socket.leave(room.code);
    currentRoom = null;
    seatIndex = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoom || seatIndex === null) return;
    const room = currentRoom;
    const rp = room.players[seatIndex];
    if (rp) rp.connected = false;

    const gs = room.state;
    if (gs && gs.phase === 'playing') {
      addLog(gs, `${gs.players[seatIndex].name} disconnected.`);
      gs.msg = `${gs.players[seatIndex].name} disconnected — waiting for reconnect…`;
      broadcastState(room);
    }

    // Clear any existing cleanup timer, then start a fresh one
    if (room.cleanupTimers[seatIndex]) clearTimeout(room.cleanupTimers[seatIndex]);
    room.cleanupTimers[seatIndex] = setTimeout(() => {
      const allGone = room.players.every(p => p.connected === false);
      if (allGone) rooms.delete(room.code);
    }, 300000); // 5 minutes
  });
});

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Shithead server running at http://localhost:${PORT}`);
});
