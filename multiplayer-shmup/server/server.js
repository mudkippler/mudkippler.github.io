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
const GRAVE_LIMIT = 50; // cap so init payload/memory don't grow unbounded

// Phase 2 co-op mechanic: both orbs must die within ORB_KILL_WINDOW of each
// other or the dead one revives. Orb HP is sized so one player at max
// reported DPS (BULLET_DAMAGE per DAMAGE_REPORT_MIN_INTERVAL = 200/s) needs
// ~1.5s per orb — killing both sequentially can't fit the window, so it
// takes two players focusing different orbs.
const ORB_MAX_HP = 300;
const ORB_KILL_WINDOW = 3000; // ms

const players = {};
const boss = { x: 400, y: 100, radius: 30, hp: 500, maxHp: 5000 };
let phase = 1; // 1: boss health bar, 2: twin orbs (co-op check), 3: defeated
let orbs = []; // {id, baseX, baseY, x, y, hp, maxHp, deadAt}
const damageLog = {}; // id -> total damage dealt to boss
const graves = []; // {x, y, color} markers left where players have died

function broadcast(message) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function bossSay(text) {
  broadcast(serialize({ type: 'bossSay', text }));
}

function publicOrbs() {
  return orbs.map(o => ({ id: o.id, x: t(o.x), y: t(o.y), hp: o.hp, maxHp: o.maxHp }));
}

function startPhase2() {
  phase = 2;
  orbs = [0, 1].map(i => {
    const x = boss.x + (i === 0 ? -150 : 150);
    const y = boss.y + 50;
    return { id: i, baseX: x, baseY: y, x, y, hp: ORB_MAX_HP, maxHp: ORB_MAX_HP, deadAt: null };
  });
  bossSay("i'm just getting started..");
}

wss.on('connection', (ws) => {
  const id = playerIdCounter;
  playerIdCounter++

  players[id] = {
    id,
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
  damageLog[id] = 0;
  ws.id = id;

  ws.send(serialize({ type: 'init', id, boss: { ...boss, x: t(boss.x), y: t(boss.y) }, graves, phase, orbs: publicOrbs() }));

  ws.on('message', (msg) => {
    try {
      const data = deserialize(new Uint8Array(msg));
      const player = players[id];
      if (!player) return;

      if (data.type === 'movementUpdate') {
        player.keys = { ...player.keys, ...data.keys };
        player.lastActive = Date.now();
      } else if (data.type === 'bossDamage') {
        if (phase !== 1) return; // boss is invulnerable once the orbs are out
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        boss.hp = Math.max(0, boss.hp - BULLET_DAMAGE);
        damageLog[id] = (damageLog[id] || 0) + BULLET_DAMAGE;

        if (boss.hp <= 0) startPhase2();
      } else if (data.type === 'orbDamage') {
        if (phase !== 2) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;

        const orb = orbs.find(o => o.id === data.orbId);
        if (!orb || orb.hp <= 0) return;
        player.lastDamageReport = now;

        orb.hp = Math.max(0, orb.hp - BULLET_DAMAGE);
        damageLog[id] = (damageLog[id] || 0) + BULLET_DAMAGE;

        if (orb.hp <= 0) {
          orb.deadAt = now;
          if (orbs.every(o => o.hp <= 0)) {
            phase = 3;
            bossSay('impossible... you struck as one...');
          }
        }
      } else if (data.type === 'playerDamage') {
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        player.health -= BULLET_DAMAGE;
        if (player.health <= 0 && !player.dead) {
          player.dead = true;

          const grave = { x: t(player.x), y: t(player.y), color: player.color };
          graves.push(grave);
          if (graves.length > GRAVE_LIMIT) graves.shift();
          const graveMessage = serialize({ type: 'grave', ...grave });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(graveMessage);
          }

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

        const chatMessage = serialize({ type: 'chat', id, color: player.color, text });
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(chatMessage);
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    delete players[ws.id];
    delete damageLog[ws.id];
  });
});

function gameLoop() {
  const now = Date.now();

  // Despawn players inactive for 60 seconds
  for (const id in players) {
    if (now - players[id].lastActive > 60000) {
      console.log(`Despawning inactive player: ${id}`);
      delete players[id];
      delete damageLog[id];
    }
  }

  // Update players
  for (const id in players) {
    const p = players[id];
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
  if (phase === 2) {
    for (const orb of orbs) {
      orb.y = orb.baseY + Math.sin(now / 400 + orb.id * Math.PI) * 15;
    }

    const dead = orbs.filter(o => o.hp <= 0);
    if (dead.length === 1 && now - dead[0].deadAt > ORB_KILL_WINDOW) {
      dead[0].hp = dead[0].maxHp;
      dead[0].deadAt = null;
      bossSay('you must strike them down together!');
    }
  }

  // Send game state: positions/health, boss health, and phase/orbs. No bullets.
  broadcast(serialize({
      type: 'state',
      players: Object.values(players).map(p => ({ id: p.id, x: t(p.x), y: t(p.y), color: p.color, health: p.health })),
      boss: { x: t(boss.x), y: t(boss.y), hp: boss.hp, maxHp: boss.maxHp },
      phase,
      orbs: publicOrbs()
  }));
}

setInterval(gameLoop, 1000 / TICK_RATE);

// Send leaderboard updates less frequently
setInterval(() => {
    const leaderboard = {
        type: 'leaderboard',
        damageLog
    };
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(serialize(leaderboard));
        }
    }
}, 1000);


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
