const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const msgpack = require('@ygoe/msgpack');


const app = express();
const server = http.createServer(app);

const USE_MSGPACK_COMPRESSION = true; // Set to false to use JSON instead of MessagePack

const wss = new WebSocket.Server({ server });

let serialize, deserialize;

if (USE_MSGPACK_COMPRESSION) {
  serialize = msgpack.serialize;
  deserialize = msgpack.deserialize;
} else {
  serialize = JSON.stringify;
  deserialize = JSON.parse;
}

app.use(express.static(path.join(__dirname, '../public')));

const t = (n) => Math.round(n * 10) / 10;

let playerIdCounter = 0;

// This is a side-by-side co-op game, not a fully synced multiplayer sim:
// bullets and their collisions are simulated locally on each client. The
// server is only authoritative for player positions/health and boss health,
// which is the minimum needed to see other players and share a boss HP pool.
const TICK_RATE = 15;
const PLAYER_SPEED = 10;
const BULLET_DAMAGE = 10; // fixed, server-defined so clients can't self-report arbitrary damage
const DAMAGE_REPORT_MIN_INTERVAL = 50; // ms, basic anti-spam guard
const CHAT_MIN_INTERVAL = 500; // ms, basic anti-spam guard
const CHAT_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 16;
const GRAVE_LIMIT = 50; // cap so init payload/memory don't grow unbounded
const LOBBY_MAX_PLAYERS = 8;
// Grace period before an empty lobby is deleted. Must comfortably exceed the
// client's respawn reconnect (~1.5s) so a solo player who dies can rejoin
// their own lobby instead of finding it gone.
const EMPTY_LOBBY_TTL = 30000; // ms

// Phase 2 co-op mechanic: both orbs must die within ORB_KILL_WINDOW of each
// other or the dead one revives. Orb HP is sized so one player at max
// reported DPS (BULLET_DAMAGE per DAMAGE_REPORT_MIN_INTERVAL = 200/s) needs
// ~1.5s per orb — killing both sequentially can't fit the window, so it
// takes two players focusing different orbs.
const ORB_MAX_HP = 300;
const ORB_KILL_WINDOW = 3000; // ms

// Encounter definitions. bossMaxHp/hasOrbPhase are authoritative here; the
// attack fields are forwarded to clients, which simulate boss bullets locally.
const ENCOUNTERS = {
  twin: {
    id: 'twin', name: 'The Twin Guardian',
    bossMaxHp: 5000, hasOrbPhase: true,
    attackRate: 100, numberOfAngles: 4, bulletSpeed: 1, bigRedChance: 0.1
  },
  storm: {
    id: 'storm', name: 'Bullet Storm',
    bossMaxHp: 3500, hasOrbPhase: false,
    attackRate: 70, numberOfAngles: 6, bulletSpeed: 1.2, bigRedChance: 0.2
  },
  blitz: {
    id: 'blitz', name: 'Blitz',
    bossMaxHp: 1500, hasOrbPhase: false,
    attackRate: 55, numberOfAngles: 4, bulletSpeed: 2, bigRedChance: 0.05
  }
};

const lobbies = {}; // code -> lobby

// Codes avoid ambiguous characters (0/O, 1/I/L) since they're shared verbally.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeLobbyCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (lobbies[code]);
  return code;
}

function createLobby(encounterId) {
  const encounter = ENCOUNTERS[encounterId] || ENCOUNTERS.twin;
  const code = makeLobbyCode();
  const lobby = {
    code,
    encounter,
    hostId: null,
    started: false,
    emptyAt: null,
    players: {},
    boss: { x: 400, y: 100, radius: 30, hp: encounter.bossMaxHp, maxHp: encounter.bossMaxHp },
    phase: 1, // 1: boss health bar, 2: twin orbs (co-op check), 3: defeated
    orbs: [], // {id, baseX, baseY, x, y, hp, maxHp, deadAt}
    damageLog: {}, // id -> {name, color, dmg}
    graves: [] // {x, y, color} markers left where players have died
  };
  lobbies[code] = lobby;
  return lobby;
}

function lobbyBroadcast(lobby, message) {
  for (const id in lobby.players) {
    const ws = lobby.players[id].ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function bossSay(lobby, text) {
  lobbyBroadcast(lobby, serialize({ type: 'bossSay', text }));
}

function publicOrbs(lobby) {
  return lobby.orbs.map(o => ({ id: o.id, x: t(o.x), y: t(o.y), hp: o.hp, maxHp: o.maxHp }));
}

function broadcastLobbyState(lobby) {
  lobbyBroadcast(lobby, serialize({
    type: 'lobbyState',
    code: lobby.code,
    hostId: lobby.hostId,
    started: lobby.started,
    encounter: { id: lobby.encounter.id, name: lobby.encounter.name },
    players: Object.values(lobby.players).map(p => ({ id: p.id, name: p.name, color: p.color }))
  }));
}

function startPhase2(lobby) {
  lobby.phase = 2;
  lobby.orbs = [0, 1].map(i => {
    const x = lobby.boss.x + (i === 0 ? -150 : 150);
    const y = lobby.boss.y + 50;
    return { id: i, baseX: x, baseY: y, x, y, hp: ORB_MAX_HP, maxHp: ORB_MAX_HP, deadAt: null };
  });
  bossSay(lobby, "i'm just getting started..");
}

function sanitizeName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH);
  return name || 'anon';
}

function joinLobby(ws, lobby, rawName) {
  const id = playerIdCounter;
  playerIdCounter++;

  const player = {
    id,
    ws,
    name: sanitizeName(rawName),
    x: Math.random() * 800,
    y: Math.random() * 600,
    vx: 0,
    vy: 0,
    color: `hsl(${t(Math.random() * 360)}, 100%, 50%)`,
    keys: {},
    lastActive: Date.now(),
    lastDamageReport: 0,
    lastChat: 0,
    health: 100,
    dead: false
  };

  lobby.players[id] = player;
  lobby.damageLog[id] = { name: player.name, color: player.color, dmg: 0 };
  lobby.emptyAt = null;
  if (lobby.hostId === null) lobby.hostId = id;

  ws.id = id;
  ws.lobbyCode = lobby.code;

  ws.send(serialize({
    type: 'joined',
    id,
    code: lobby.code,
    hostId: lobby.hostId,
    started: lobby.started,
    encounter: lobby.encounter,
    boss: { ...lobby.boss, x: t(lobby.boss.x), y: t(lobby.boss.y) },
    graves: lobby.graves,
    phase: lobby.phase,
    orbs: publicOrbs(lobby)
  }));
  broadcastLobbyState(lobby);
}

function leaveLobby(ws) {
  const lobby = lobbies[ws.lobbyCode];
  if (!lobby) return;

  delete lobby.players[ws.id];
  delete lobby.damageLog[ws.id];

  const remaining = Object.keys(lobby.players);
  if (remaining.length === 0) {
    lobby.emptyAt = Date.now();
  } else {
    if (lobby.hostId === ws.id) lobby.hostId = Number(remaining[0]);
    broadcastLobbyState(lobby);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = deserialize(new Uint8Array(msg));

      // Pre-lobby messages: create or join. Everything else needs a lobby.
      if (data.type === 'createLobby') {
        if (ws.lobbyCode) return;
        const lobby = createLobby(data.encounter);
        joinLobby(ws, lobby, data.name);
        return;
      }

      if (data.type === 'joinLobby') {
        if (ws.lobbyCode) return;
        const code = String(data.code || '').trim().toUpperCase();
        const lobby = lobbies[code];
        if (!lobby) {
          ws.send(serialize({ type: 'lobbyError', message: `Lobby ${code} not found.` }));
          return;
        }
        if (Object.keys(lobby.players).length >= LOBBY_MAX_PLAYERS) {
          ws.send(serialize({ type: 'lobbyError', message: `Lobby ${code} is full.` }));
          return;
        }
        joinLobby(ws, lobby, data.name);
        return;
      }

      const lobby = lobbies[ws.lobbyCode];
      if (!lobby) return;
      const player = lobby.players[ws.id];
      if (!player) return;

      if (data.type === 'startGame') {
        if (ws.id !== lobby.hostId || lobby.started) return;
        lobby.started = true;
        broadcastLobbyState(lobby);
        lobbyBroadcast(lobby, serialize({ type: 'gameStart' }));
      } else if (data.type === 'movementUpdate') {
        player.keys = { ...player.keys, ...data.keys };
        player.lastActive = Date.now();
      } else if (data.type === 'bossDamage') {
        if (!lobby.started || lobby.phase !== 1) return; // boss is invulnerable once the orbs are out
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        lobby.boss.hp = Math.max(0, lobby.boss.hp - BULLET_DAMAGE);
        lobby.damageLog[ws.id].dmg += BULLET_DAMAGE;

        if (lobby.boss.hp <= 0) {
          if (lobby.encounter.hasOrbPhase) {
            startPhase2(lobby);
          } else {
            lobby.phase = 3;
            bossSay(lobby, 'impossible... defeated...');
          }
        }
      } else if (data.type === 'orbDamage') {
        if (!lobby.started || lobby.phase !== 2) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;

        const orb = lobby.orbs.find(o => o.id === data.orbId);
        if (!orb || orb.hp <= 0) return;
        player.lastDamageReport = now;

        orb.hp = Math.max(0, orb.hp - BULLET_DAMAGE);
        lobby.damageLog[ws.id].dmg += BULLET_DAMAGE;

        if (orb.hp <= 0) {
          orb.deadAt = now;
          if (lobby.orbs.every(o => o.hp <= 0)) {
            lobby.phase = 3;
            bossSay(lobby, 'impossible... you struck as one...');
          }
        }
      } else if (data.type === 'playerDamage') {
        if (!lobby.started) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        player.health -= BULLET_DAMAGE;
        if (player.health <= 0 && !player.dead) {
          player.dead = true;

          const grave = { x: t(player.x), y: t(player.y), color: player.color };
          lobby.graves.push(grave);
          if (lobby.graves.length > GRAVE_LIMIT) lobby.graves.shift();
          lobbyBroadcast(lobby, serialize({ type: 'grave', ...grave }));

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialize({ type: 'dead' }));
            // close() flushes the queued 'dead' message before closing the
            // connection; terminate() destroys the socket immediately and
            // can drop it (client never learns it died).
            ws.close(1000, 'dead');
          }
        }
      } else if (data.type === 'chat') {
        const now = Date.now();
        if (now - player.lastChat < CHAT_MIN_INTERVAL) return;

        const text = String(data.text || '').slice(0, CHAT_MAX_LENGTH).trim();
        if (!text) return;
        player.lastChat = now;

        lobbyBroadcast(lobby, serialize({ type: 'chat', id: ws.id, name: player.name, color: player.color, text }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    leaveLobby(ws);
  });
});

function gameLoop() {
  const now = Date.now();

  for (const code in lobbies) {
    const lobby = lobbies[code];

    // Reap lobbies that have been empty past the grace period
    if (lobby.emptyAt !== null && now - lobby.emptyAt > EMPTY_LOBBY_TTL && Object.keys(lobby.players).length === 0) {
      delete lobbies[code];
      continue;
    }

    if (!lobby.started) continue;

    // Despawn players inactive for 60 seconds
    for (const id in lobby.players) {
      if (now - lobby.players[id].lastActive > 60000) {
        console.log(`Despawning inactive player: ${id} (lobby ${code})`);
        const ws = lobby.players[id].ws;
        delete lobby.players[id];
        delete lobby.damageLog[id];
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'inactive');
        if (Object.keys(lobby.players).length === 0) lobby.emptyAt = now;
        else if (lobby.hostId === Number(id)) lobby.hostId = Number(Object.keys(lobby.players)[0]);
      }
    }

    // Update players
    for (const id in lobby.players) {
      const p = lobby.players[id];
      p.vx = 0;
      p.vy = 0;
      if (p.keys['ArrowUp'] || p.keys['w']) p.vy -= 1;
      if (p.keys['ArrowDown'] || p.keys['s']) p.vy += 1;
      if (p.keys['ArrowLeft'] || p.keys['a']) p.vx -= 1;
      if (p.keys['ArrowRight'] || p.keys['d']) p.vx += 1;

      const len = Math.hypot(p.vx, p.vy);
      if (len > 0) {
        p.vx /= len;
        p.vy /= len;
      }

      p.x += p.vx * PLAYER_SPEED;
      p.y += p.vy * PLAYER_SPEED;

      // Clamp player position to screen bounds
      p.x = Math.max(0, Math.min(800, p.x));
      p.y = Math.max(0, Math.min(600, p.y));
    }

    // Phase 2: bob the orbs and enforce the kill-together window
    if (lobby.phase === 2) {
      for (const orb of lobby.orbs) {
        orb.y = orb.baseY + Math.sin(now / 400 + orb.id * Math.PI) * 15;
      }

      const dead = lobby.orbs.filter(o => o.hp <= 0);
      if (dead.length === 1 && now - dead[0].deadAt > ORB_KILL_WINDOW) {
        dead[0].hp = dead[0].maxHp;
        dead[0].deadAt = null;
        bossSay(lobby, 'you must strike them down together!');
      }
    }

    // Send game state: positions/health, boss health, and phase/orbs. No bullets.
    lobbyBroadcast(lobby, serialize({
      type: 'state',
      players: Object.values(lobby.players).map(p => ({ id: p.id, x: t(p.x), y: t(p.y), color: p.color, health: p.health, name: p.name })),
      boss: { x: t(lobby.boss.x), y: t(lobby.boss.y), hp: lobby.boss.hp, maxHp: lobby.boss.maxHp },
      phase: lobby.phase,
      orbs: publicOrbs(lobby)
    }));
  }
}

setInterval(gameLoop, 1000 / TICK_RATE);

// Send leaderboard updates less frequently
setInterval(() => {
  for (const code in lobbies) {
    const lobby = lobbies[code];
    if (!lobby.started) continue;
    lobbyBroadcast(lobby, serialize({ type: 'leaderboard', damageLog: lobby.damageLog }));
  }
}, 1000);


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
