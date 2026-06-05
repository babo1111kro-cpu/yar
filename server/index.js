const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { createGameState, processAction, getFieldMonsters } = require('./gameLogic');
const CARDS = require('./cards.json');

const PORT = process.env.PORT || 3001;
const wss = new WebSocket.Server({ port: PORT });

// 대기실: roomId -> { players: [{id, ws, name}], status }
const rooms = new Map();
// 게임: gameId -> { state, players: {[playerId]: ws} }
const games = new Map();
// 플레이어: socketId -> { roomId, gameId, playerId, name }
const clients = new Map();

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(wsArr, data) {
  wsArr.forEach(ws => send(ws, data));
}

function sanitizeState(state, forPlayerId) {
  // 상대 손패는 숨기고 장수만 전달
  const result = JSON.parse(JSON.stringify(state));
  for (const [pid, player] of Object.entries(result.players)) {
    if (pid !== forPlayerId) {
      player.handCount = player.hand.length;
      player.hand = player.hand.map(() => ({ hidden: true }));
      player.deckCount = player.deck.length;
      player.deck = [];
    } else {
      player.deckCount = player.deck.length;
      player.deck = [];
    }
    // Set → Array
    player.usedOnceCards = Array.from(player.usedOnceCards || []);
  }
  return result;
}

wss.on('connection', (ws) => {
  const socketId = uuidv4();
  clients.set(socketId, { socketId });
  ws.socketId = socketId;

  send(ws, { type: 'CONNECTED', socketId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(socketId);

    switch (msg.type) {
      // ─── 방 만들기 ───
      case 'CREATE_ROOM': {
        const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
        const playerId = uuidv4();
        rooms.set(roomId, {
          roomId,
          players: [{ socketId, ws, name: msg.name || '플레이어1', playerId }],
          status: 'waiting'
        });
        clients.set(socketId, { ...client, roomId, playerId, name: msg.name });
        send(ws, { type: 'ROOM_CREATED', roomId, playerId, name: msg.name });
        break;
      }

      // ─── 방 참가 ───
      case 'JOIN_ROOM': {
        const room = rooms.get(msg.roomId);
        if (!room) return send(ws, { type: 'ERROR', message: '존재하지 않는 방입니다.' });
        if (room.players.length >= 2) return send(ws, { type: 'ERROR', message: '방이 꽉 찼습니다.' });

        const playerId = uuidv4();
        room.players.push({ socketId, ws, name: msg.name || '플레이어2', playerId });
        clients.set(socketId, { ...client, roomId: msg.roomId, playerId, name: msg.name });

        send(ws, { type: 'ROOM_JOINED', roomId: msg.roomId, playerId, name: msg.name });

        // 두 명 모두 입장 → 덱 제출 요청
        broadcast(room.players.map(p => p.ws), {
          type: 'ROOM_READY',
          roomId: msg.roomId,
          players: room.players.map(p => ({ playerId: p.playerId, name: p.name })),
          message: '모든 플레이어가 입장했습니다. 덱을 제출해주세요.'
        });
        break;
      }

      // ─── 방 목록 ───
      case 'LIST_ROOMS': {
        const list = [];
        for (const [rid, room] of rooms) {
          if (room.status === 'waiting') {
            list.push({ roomId: rid, playerCount: room.players.length, host: room.players[0]?.name });
          }
        }
        send(ws, { type: 'ROOM_LIST', rooms: list });
        break;
      }

      // ─── 덱 제출 ───
      case 'SUBMIT_DECK': {
        const room = rooms.get(client.roomId);
        if (!room) return;

        const deck = msg.deck; // card id 배열 or card 객체 배열
        if (!deck || deck.length < 25 || deck.length > 30) {
          return send(ws, { type: 'ERROR', message: '덱은 25~30장이어야 합니다.' });
        }

        // card id -> card 객체 변환
        const deckCards = deck.map(item => {
          const id = typeof item === 'string' ? item : item.id;
          return CARDS.find(c => c.id === id);
        }).filter(Boolean);

        const playerEntry = room.players.find(p => p.socketId === socketId);
        if (playerEntry) playerEntry.deck = deckCards;

        // 모두 제출했는지 확인
        const allReady = room.players.length === 2 && room.players.every(p => p.deck);
        if (allReady) {
          const [p1, p2] = room.players;
          const state = createGameState(p1.playerId, p2.playerId, p1.deck, p2.deck);
          const gameId = state.gameId;
          room.gameId = gameId;
          room.status = 'playing';

          games.set(gameId, {
            state,
            players: {
              [p1.playerId]: p1.ws,
              [p2.playerId]: p2.ws,
            },
            playerNames: {
              [p1.playerId]: p1.name,
              [p2.playerId]: p2.name,
            }
          });

          clients.get(p1.socketId).gameId = gameId;
          clients.get(p2.socketId).gameId = gameId;

          // 각 플레이어에게 게임 시작 알림
          send(p1.ws, {
            type: 'GAME_START',
            gameId,
            playerId: p1.playerId,
            opponentName: p2.name,
            state: sanitizeState(state, p1.playerId),
            yourTurn: state.currentPlayer === p1.playerId
          });
          send(p2.ws, {
            type: 'GAME_START',
            gameId,
            playerId: p2.playerId,
            opponentName: p1.name,
            state: sanitizeState(state, p2.playerId),
            yourTurn: state.currentPlayer === p2.playerId
          });
        } else {
          send(ws, { type: 'DECK_SUBMITTED', message: '덱 제출 완료. 상대방을 기다리는 중...' });
        }
        break;
      }

      // ─── 게임 액션 ───
      case 'GAME_ACTION': {
        const game = games.get(client.gameId);
        if (!game) return send(ws, { type: 'ERROR', message: '게임을 찾을 수 없습니다.' });

        const { state, log } = processAction(game.state, client.playerId, msg.action);
        game.state = state;

        // 양쪽에 업데이트 전송
        for (const [pid, pws] of Object.entries(game.players)) {
          send(pws, {
            type: 'GAME_UPDATE',
            state: sanitizeState(state, pid),
            log,
            yourTurn: state.currentPlayer === pid,
            actionBy: client.playerId
          });
        }

        // 게임 종료 처리
        if (state.phase === 'ended') {
          const winnerName = game.playerNames[state.winner] || state.winner;
          for (const pws of Object.values(game.players)) {
            send(pws, { type: 'GAME_ENDED', winner: state.winner, winnerName });
          }
          games.delete(client.gameId);
          const room = rooms.get(client.roomId);
          if (room) room.status = 'ended';
        }
        break;
      }

      // ─── 채팅 ───
      case 'CHAT': {
        const game = games.get(client.gameId);
        if (!game) break;
        for (const pws of Object.values(game.players)) {
          send(pws, { type: 'CHAT', from: client.name, message: msg.message });
        }
        break;
      }

      // ─── 항복 ───
      case 'SURRENDER': {
        const game = games.get(client.gameId);
        if (!game) break;
        const oppId = Object.keys(game.players).find(pid => pid !== client.playerId);
        for (const [pid, pws] of Object.entries(game.players)) {
          send(pws, {
            type: 'GAME_ENDED',
            winner: oppId,
            winnerName: game.playerNames[oppId],
            reason: `${client.name}이(가) 항복했습니다.`
          });
        }
        games.delete(client.gameId);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(socketId);
    if (client?.gameId) {
      const game = games.get(client.gameId);
      if (game) {
        const oppId = Object.keys(game.players).find(pid => pid !== client.playerId);
        const oppWs = game.players[oppId];
        if (oppWs) {
          send(oppWs, { type: 'GAME_ENDED', winner: oppId, winnerName: game.playerNames[oppId], reason: '상대방이 연결을 끊었습니다.' });
        }
        games.delete(client.gameId);
      }
    }
    if (client?.roomId) {
      const room = rooms.get(client.roomId);
      if (room && room.status === 'waiting') {
        rooms.delete(client.roomId);
      }
    }
    clients.delete(socketId);
  });
});

console.log(`🎴 카드게임 서버 실행 중: ws://localhost:${PORT}`);
