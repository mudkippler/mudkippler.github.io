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
const SHOT_RELAY_MIN_INTERVAL = 150; // ms, just under the client's fire cooldown
// Death is permanent within a run: a living teammate must stand on the body
// for REVIVE_TIME to bring a player back. If everyone is dead the encounter
// resets after a short pause so the lobby isn't stuck.
const REVIVE_RADIUS = 30; // px
const REVIVE_TIME = 3000; // ms of continuous overlap
// Stepping off the body doesn't instantly forfeit progress — it drains at a
// fraction of the fill rate, so a brief interruption isn't a full restart.
const REVIVE_DECAY_MULTIPLIER = 0.4;
const REVIVE_HEALTH = 50; // revived players come back at half health
const TEAM_WIPE_RESET_DELAY = 4000; // ms
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

// 20 hand-picked hues, spread far apart in hue/lightness so adjacent players
// are easy to tell apart at a glance. Avoids gray (the boss) and violet
// (the orbs) to keep those readable as distinct entities.
const PLAYER_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#ffd8b1', '#ff6347', '#7fffd4', '#ff69b4', '#1e90ff'
];

const lobbies = {}; // code -> lobby

function assignColorIndex(lobby) {
  const used = new Set(Object.values(lobby.players).map(p => p.colorIndex));
  for (let i = 0; i < PLAYER_COLORS.length; i++) {
    if (!used.has(i)) return i;
  }
  // More players than colors shouldn't happen (LOBBY_MAX_PLAYERS < 20), but
  // fall back to cycling rather than crashing.
  return Object.keys(lobby.players).length % PLAYER_COLORS.length;
}

// Players always spawn at the bottom-center of the 800x600 arena, clear of
// the boss up near the top, with a little jitter so they don't fully stack.
function spawnPosition() {
  return { x: 350 + Math.random() * 100, y: 540 + Math.random() * 40 };
}

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
    wipeAt: null, // set when every player is dead; encounter resets shortly after
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

  const colorIndex = assignColorIndex(lobby);
  const spawn = spawnPosition();

  const player = {
    id,
    ws,
    name: sanitizeName(rawName),
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    colorIndex,
    color: PLAYER_COLORS[colorIndex],
    keys: {},
    lastActive: Date.now(),
    lastDamageReport: 0,
    lastChat: 0,
    lastShotRelay: 0,
    health: 100,
    dead: false,
    reviveProgress: 0 // ms a living teammate has spent standing on this body
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
        if (!lobby.started || player.dead) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        player.health -= BULLET_DAMAGE;
        if (player.health <= 0 && !player.dead) {
          player.health = 0;
          player.dead = true;
          player.reviveProgress = 0;

          const grave = { x: t(player.x), y: t(player.y), color: player.color };
          lobby.graves.push(grave);
          if (lobby.graves.length > GRAVE_LIMIT) lobby.graves.shift();
          lobbyBroadcast(lobby, serialize({ type: 'grave', ...grave }));

          // Death is permanent: the socket stays open so the player can
          // spectate and be revived by a teammate standing on the body.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serialize({ type: 'dead' }));
          }

          if (Object.values(lobby.players).every(p => p.dead)) {
            lobby.wipeAt = now;
            bossSay(lobby, 'and so falls your whole party...');
          }
        }
      } else if (data.type === 'shot') {
        // Relay the shot origin to teammates so they can render ally bullets
        // locally. Trajectory is implied (bullets always travel straight up).
        if (!lobby.started || player.dead) return;
        const now = Date.now();
        if (now - player.lastShotRelay < SHOT_RELAY_MIN_INTERVAL) return;
        player.lastShotRelay = now;

        const x = Math.max(0, Math.min(800, Number(data.x) || 0));
        const y = Math.max(0, Math.min(600, Number(data.y) || 0));
        const shotMessage = serialize({ type: 'shot', id: ws.id, x: t(x), y: t(y), color: player.color });
        for (const pid in lobby.players) {
          if (Number(pid) === ws.id) continue; // shooter already renders its own bullet
          const peer = lobby.players[pid].ws;
          if (peer && peer.readyState === WebSocket.OPEN) peer.send(shotMessage);
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

    // A full wipe resets the encounter after a short pause
    if (lobby.wipeAt !== null && now - lobby.wipeAt > TEAM_WIPE_RESET_DELAY) {
      lobby.wipeAt = null;
      lobby.boss.hp = lobby.boss.maxHp;
      lobby.phase = 1;
      lobby.orbs = [];
      for (const id in lobby.players) {
        const p = lobby.players[id];
        const spawn = spawnPosition();
        p.dead = false;
        p.health = 100;
        p.reviveProgress = 0;
        p.x = spawn.x;
        p.y = spawn.y;
        p.keys = {};
      }
      bossSay(lobby, 'back for another beating?');
    }

    // Update players (dead bodies stay where they fell)
    for (const id in lobby.players) {
      const p = lobby.players[id];
      if (p.dead) continue;
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

    // Revives: a living teammate standing on a body fills its revive meter;
    // stepping away resets it.
    const livingPlayers = Object.values(lobby.players).filter(p => !p.dead);
    for (const id in lobby.players) {
      const d = lobby.players[id];
      if (!d.dead) continue;
      const beingRevived = livingPlayers.some(p => Math.hypot(p.x - d.x, p.y - d.y) < REVIVE_RADIUS);
      if (beingRevived) {
        d.reviveProgress += 1000 / TICK_RATE;
        if (d.reviveProgress >= REVIVE_TIME) {
          d.dead = false;
          d.health = REVIVE_HEALTH;
          d.reviveProgress = 0;
          if (d.ws && d.ws.readyState === WebSocket.OPEN) d.ws.send(serialize({ type: 'revived' }));
        }
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - (1000 / TICK_RATE) * REVIVE_DECAY_MULTIPLIER);
      }
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
      players: Object.values(lobby.players).map(p => ({
        id: p.id, x: t(p.x), y: t(p.y), color: p.color, health: p.health, name: p.name,
        dead: p.dead, revive: p.dead ? t(p.reviveProgress / REVIVE_TIME) : 0
      })),
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
