import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import msgpack from '@ygoe/msgpack';
import { ENCOUNTERS } from './encounters.js';
import { createPhaseEngine } from './phases.js';
let {
    USE_MSGPACK_COMPRESSION,
    TICK_RATE,
    PLAYER_SPEED_PER_SEC,
    PLAYER_BULLET_SPEED,
    BULLET_DAMAGE,
    PLAYER_DAMAGE_BY_SOURCE,
    WIND_MAX_STRENGTH,
    UMBRELLA_BLOWN_GUST,
    DAMAGE_REPORT_MIN_INTERVAL,
    CHAT_MIN_INTERVAL,
    CHAT_MAX_LENGTH,
    SHOT_RELAY_MIN_INTERVAL,
    REVIVE_RADIUS,
    REVIVE_TIME,
    REVIVE_DECAY_MULTIPLIER,
    REVIVE_HEALTH,
    TEAM_WIPE_RESET_DELAY,
    NAME_MAX_LENGTH,
    GRAVE_LIMIT,
    LOBBY_MAX_PLAYERS,
    EMPTY_LOBBY_TTL,
    PLAYER_COLORS
} = await import('../shared/config.js');

if (process.env.FAST_TESTS === '1') {
    TEAM_WIPE_RESET_DELAY = 900;
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

let serialize, deserialize;

if (USE_MSGPACK_COMPRESSION) {
  serialize = msgpack.serialize;
  deserialize = msgpack.deserialize;
} else {
  serialize = JSON.stringify;
  deserialize = JSON.parse;
}

app.use(express.static(path.join(__dirname, '../public')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

const t = (n) => Math.round(n * 10) / 10;

let playerIdCounter = 0;

// This is a side-by-side co-op game, not a fully synced multiplayer sim:
// bullets and their collisions are simulated locally on each client. The
// server is only authoritative for player positions/health and boss health,
// which is the minimum needed to see other players and share a boss HP pool.


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
    paused: false, // host-toggled; freezes simulation but keeps state broadcasts flowing
    emptyAt: null,
    wipeAt: null, // set when every player is dead; encounter resets shortly after
    players: {},
    boss: { x: 400, y: 100, radius: 30, hp: encounter.phases[0].bossHp, maxHp: encounter.phases[0].bossHp },
    phaseIndex: 0, // index into encounter.phases; the phase def is authoritative for what's damageable/active
    phaseState: {}, // per-phase scratch for the phase's server behavior (see phases.js)
    mech: null, // per-tick mechanic values some behaviors broadcast (ray angle, moon position, ...)
    orbs: [], // {id, kind, baseAngle, x, y, hp, maxHp, deadAt} — spawned/owned by the twinOrbs behavior
    damageLog: {}, // id -> {name, color, dmg}
    graves: [], // {x, y, color} markers left where players have died
    hpTaunts: new Set() // 'phase1-75'/'enrage-25'/etc — HP milestones already spoken this run
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

function bossSay(lobby, text, intensity = 0) {
  lobbyBroadcast(lobby, serialize({ type: 'bossSay', text, intensity }));
}

// Kills a player outright: marks them dead, drops a grave, tells their own
// socket, and starts the team-wipe clock if that was the last one standing.
// Shared by the playerDamage handler (health hits zero) and any server-side
// hazard that insta-kills (e.g. the launchCodes maze's walls/timeout — see
// phases.js), so both paths leave the lobby in the same state.
function killPlayer(lobby, player, now) {
  if (player.dead) return;
  player.health = 0;
  player.dead = true;
  player.reviveProgress = 0;

  const grave = { x: t(player.x), y: t(player.y), color: player.color };
  lobby.graves.push(grave);
  if (lobby.graves.length > GRAVE_LIMIT) lobby.graves.shift();
  lobbyBroadcast(lobby, serialize({ type: 'grave', ...grave }));

  if (player.ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(serialize({ type: 'dead' }));
  }

  if (Object.values(lobby.players).every(p => p.dead)) {
    lobby.wipeAt = now;
    bossSay(lobby, 'and so falls your whole party...');
  }
}

// Drives each lobby through its encounter's phase list — phase entry/exit,
// HP-milestone dialogue, and the per-tick boss behaviors all live in
// phases.js; the encounter/phase data itself lives in encounters.js.
const phases = createPhaseEngine({
  say: bossSay,
  emit: (lobby, message) => lobbyBroadcast(lobby, serialize(message)),
  t,
  killPlayer
});

// The encounter object forwarded to clients on join/change: the same phase
// list the server runs, minus the dialogue tables — those are only ever
// spoken via bossSay, and dropping them keeps the join payload lean.
function publicEncounter(encounter) {
  return { ...encounter, phases: encounter.phases.map(({ say, ...phase }) => phase) };
}

function publicOrbs(lobby) {
  return lobby.orbs.map(o => ({ id: o.id, ...(o.kind ? { kind: o.kind } : {}), x: t(o.x), y: t(o.y), hp: o.hp, maxHp: o.maxHp }));
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

// Resets an in-progress or finished encounter back to its opening phase with
// full boss HP and every player alive at full health. Used both for the
// automatic team-wipe recovery and a host-triggered restart after victory.
function resetEncounter(lobby) {
  lobby.wipeAt = null;
  lobby.boss.x = 400;
  lobby.boss.y = 100;
  lobby.hpTaunts = new Set();
  // silent: the reset paths speak their own line ('back for another beating?')
  // instead of re-firing the phase's entry dialogue.
  phases.enterPhase(lobby, 0, { silent: true });
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
    // Damage dealt (boss/orb) and damage taken are throttled separately so a
    // damage-over-time hazard ticking against the player can't starve their
    // own hit reports out of the anti-spam window (or vice versa).
    lastDealtReport: 0,
    lastTakenReport: 0,
    lastChat: 0,
    lastShotRelay: 0,
    lastPosReport: 0, // ms timestamp of the last accepted client position report

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
    encounter: publicEncounter(lobby.encounter),
    boss: { ...lobby.boss, x: t(lobby.boss.x), y: t(lobby.boss.y) },
    graves: lobby.graves,
    phase: lobby.phaseIndex,
    orbs: publicOrbs(lobby),
    paused: lobby.paused
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

      // While paused, freeze anything that would move the fight forward;
      // pause/restart controls and chat still go through so the host can
      // resume or bail out to a different boss.
      const PAUSE_EXEMPT_TYPES = new Set(['startGame', 'togglePause', 'restartGame', 'chat']);
      if (lobby.paused && !PAUSE_EXEMPT_TYPES.has(data.type)) return;

      if (data.type === 'startGame') {
        if (ws.id !== lobby.hostId || lobby.started) return;
        lobby.started = true;
        broadcastLobbyState(lobby);
        lobbyBroadcast(lobby, serialize({ type: 'gameStart' }));
        // Re-enter the opening phase: createLobby sized boss HP assuming just
        // the host, and enterPhase rescales it for everyone who joined since
        // (plus fires the phase's entry line).
        phases.enterPhase(lobby, 0);
      } else if (data.type === 'togglePause') {
        if (ws.id !== lobby.hostId || !lobby.started) return;
        lobby.paused = !lobby.paused;
      } else if (data.type === 'restartGame') {
        // Host can restart at any point in the fight, not just after victory
        // — this doubles as the "give up and try a different boss" control.
        // Omitting encounterId (the post-victory restart button) just re-fights
        // the current one.
        if (ws.id !== lobby.hostId) return;
        if (data.encounterId && ENCOUNTERS[data.encounterId]) {
          lobby.encounter = ENCOUNTERS[data.encounterId];
        }
        lobby.paused = false;
        resetEncounter(lobby);
        bossSay(lobby, 'back for another beating?');
        lobbyBroadcast(lobby, serialize({ type: 'encounterChanged', encounter: publicEncounter(lobby.encounter) }));
      } else if (data.type === 'movementUpdate') {
        player.keys = { ...player.keys, ...data.keys };
        player.lastActive = Date.now();

        // The client reports its own predicted position and we adopt it, so
        // the player's ship never has to be corrected on their own screen
        // (reconciliation tug was visible as pixel drift). The report is
        // sanity-checked against max movement speed so a hacked client can't
        // teleport: a rejected report keeps the server's copy, which also
        // covers the race right after a server-side respawn teleport (stale
        // in-flight reports from the old spot get rejected until the client
        // snaps to the new position).
        if (!player.dead && Number.isFinite(data.x) && Number.isFinite(data.y)) {
          const now = Date.now();
          // Allowance accrues since the last *accepted* report (capped), so a
          // single rejected/lost packet doesn't cascade into rejecting every
          // subsequent report, while a genuine teleport stays out of reach of
          // the cap forever.
          const elapsed = Math.min((now - player.lastPosReport) / 1000, 0.5);
          // Storm's wind can push a player well beyond their own top speed —
          // give the cap extra slack matching the wind's max strength so a
          // legitimate gust-blown report doesn't get rejected as a teleport.
          const windSlack = phases.currentPhase(lobby).wind ? WIND_MAX_STRENGTH * elapsed * 1.5 : 0;
          const maxDist = PLAYER_SPEED_PER_SEC * elapsed * 1.5 + 2 + windSlack;
          const nx = Math.max(0, Math.min(800, data.x));
          const ny = Math.max(0, Math.min(600, data.y));
          if (Math.hypot(nx - player.x, ny - player.y) <= maxDist) {
            player.x = nx;
            player.y = ny;
            player.lastPosReport = now;
          }
        }
      } else if (data.type === 'bossDamage') {
        // Which phases leave the boss damageable is part of the phase data —
        // e.g. it's invulnerable during the orb phase and once defeated.
        if (!lobby.started || !phases.currentPhase(lobby).bossDamageable) return;
        const now = Date.now();
        if (now - player.lastDealtReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDealtReport = now;

        lobby.boss.hp = Math.max(0, lobby.boss.hp - BULLET_DAMAGE);
        lobby.damageLog[ws.id].dmg += BULLET_DAMAGE;
        phases.checkHpTaunts(lobby);

        if (lobby.boss.hp <= 0) phases.trigger(lobby, 'bossHpZero');
      } else if (data.type === 'orbDamage') {
        if (!lobby.started || !phases.currentPhase(lobby).orbsDamageable) return;
        const now = Date.now();
        if (now - player.lastDealtReport < DAMAGE_REPORT_MIN_INTERVAL) return;

        const orb = lobby.orbs.find(o => o.id === data.orbId);
        if (!orb || orb.hp <= 0) return;
        player.lastDealtReport = now;

        orb.hp = Math.max(0, orb.hp - BULLET_DAMAGE);
        lobby.damageLog[ws.id].dmg += BULLET_DAMAGE;

        if (orb.hp <= 0) {
          orb.deadAt = now;
          if (lobby.orbs.every(o => o.hp <= 0)) phases.trigger(lobby, 'orbsDead');
        }
      } else if (data.type === 'playerDamage') {
        if (!lobby.started || player.dead) return;
        const now = Date.now();
        if (now - player.lastTakenReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastTakenReport = now;

        const damage = PLAYER_DAMAGE_BY_SOURCE[data.source] || BULLET_DAMAGE;
        player.health -= damage;
        // Death is permanent: the socket stays open so the player can
        // spectate and be revived by a teammate standing on the body.
        if (player.health <= 0) killPlayer(lobby, player, now);
      } else if (data.type === 'shot') {
        // Relay the shot origin and aim direction to teammates so they can
        // render ally bullets locally.
        if (!lobby.started || player.dead) return;
        const now = Date.now();
        if (now - player.lastShotRelay < SHOT_RELAY_MIN_INTERVAL) return;
        player.lastShotRelay = now;

        const x = Math.max(0, Math.min(800, Number(data.x) || 0));
        const y = Math.max(0, Math.min(600, Number(data.y) || 0));

        // Clamp the reported aim vector's magnitude so a client can't relay
        // an unrealistically fast-looking bullet to teammates.
        let dx = Number(data.dx) || 0;
        let dy = Number(data.dy);
        if (!Number.isFinite(dy)) dy = -PLAYER_BULLET_SPEED;
        const speed = Math.hypot(dx, dy) || 1;
        if (speed > PLAYER_BULLET_SPEED) {
          dx = (dx / speed) * PLAYER_BULLET_SPEED;
          dy = (dy / speed) * PLAYER_BULLET_SPEED;
        }

        const shotMessage = serialize({ type: 'shot', id: ws.id, x: t(x), y: t(y), dx: t(dx), dy: t(dy), color: player.color });
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

let lastTickTime = Date.now();

function gameLoop() {
  const now = Date.now();
  // Clamp dt so a long stall (debugger pause, laptop sleep) doesn't teleport
  // everyone forward in one tick — worst case movement just briefly lags.
  const dt = Math.min((now - lastTickTime) / 1000, 0.25);
  lastTickTime = now;

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

    // Everything below advances the fight; skip it all while the host has
    // paused, but keep broadcasting state below so clients see `paused: true`
    // and nothing silently goes stale for a reconnecting/late-joining client.
    if (!lobby.paused) {
      // A full wipe resets the encounter after a short pause
      if (lobby.wipeAt !== null && now - lobby.wipeAt > TEAM_WIPE_RESET_DELAY) {
        resetEncounter(lobby);
        bossSay(lobby, 'back for another beating?');
      }

      // Storm's wind: two layered sine waves for a direction/strength that
      // smoothly gusts over time rather than flipping instantly. Computed
      // server-side and broadcast as the actual x/y push (not the formula)
      // so every client's local prediction agrees on the same gusts without
      // needing clock sync. Only runs during phases flagged for it.
      if (phases.currentPhase(lobby).wind) {
        const wt = now / 1000;
        const windAngle = Math.sin(wt * 0.15) * 1.0 + Math.sin(wt * 0.37) * 0.4;
        const gust = Math.pow(0.5 + 0.5 * Math.sin(wt * 0.5), 6); // occasional strong pulses, mostly calm between
        const windStrength = 30 + gust * (WIND_MAX_STRENGTH - 30);
        // The same gust that's strong enough to shove players around is what
        // tears the umbrella out of their hands — see UMBRELLA_BLOWN_GUST in
        // the client's rain density calc for the other half of this trade.
        lobby.wind = {
          x: Math.cos(windAngle) * windStrength,
          y: Math.sin(windAngle) * windStrength * 0.15,
          umbrella: gust <= UMBRELLA_BLOWN_GUST
        };
      } else {
        lobby.wind = null;
      }

      // Update players (dead bodies stay where they fell)
      for (const id in lobby.players) {
        const p = lobby.players[id];
        if (p.dead) continue;

        // Players who report their own predicted position (real clients) are
        // authoritative for it — simulating keys on top would fight the
        // reports and jitter. Key-based simulation remains as the fallback
        // for clients that only send keys (e.g. the test harness).
        if (now - (p.lastPosReport || 0) < 400) continue;

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

        p.x += p.vx * PLAYER_SPEED_PER_SEC * dt;
        p.y += p.vy * PLAYER_SPEED_PER_SEC * dt;
        if (lobby.wind) {
          p.x += lobby.wind.x * dt;
          p.y += lobby.wind.y * dt;
        }

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
          d.reviveProgress += dt * 1000;
          if (d.reviveProgress >= REVIVE_TIME) {
            d.dead = false;
            d.health = REVIVE_HEALTH;
            d.reviveProgress = 0;
            if (d.ws && d.ws.readyState === WebSocket.OPEN) d.ws.send(serialize({ type: 'revived' }));
          }
        } else {
          d.reviveProgress = Math.max(0, d.reviveProgress - dt * 1000 * REVIVE_DECAY_MULTIPLIER);
        }
      }

      // The active phase's server-side behavior: orb bobbing/kill-window,
      // the enrage chase's roaming + aimed shots, etc. (see phases.js).
      phases.update(lobby, now, dt);
    }

    // Send game state: positions/health, boss health, and phase/orbs. No bullets.
    lobbyBroadcast(lobby, serialize({
      type: 'state',
      players: Object.values(lobby.players).map(p => ({
        id: p.id, x: t(p.x), y: t(p.y), color: p.color, health: p.health, name: p.name,
        dead: p.dead, revive: p.dead ? t(p.reviveProgress / REVIVE_TIME) : 0,
        // Only meaningful during launchCodes (see phases.js); harmless
        // false elsewhere.
        finished: !!(lobby.phaseState.reached && lobby.phaseState.reached.has(p.id))
      })),
      boss: { x: t(lobby.boss.x), y: t(lobby.boss.y), hp: lobby.boss.hp, maxHp: lobby.boss.maxHp },
      phase: lobby.phaseIndex,
      orbs: publicOrbs(lobby),
      paused: lobby.paused,
      // wind/mech are omitted entirely outside the phases that use them to
      // save bytes on every other encounter/lobby's per-tick broadcast.
      ...(lobby.wind ? { wind: { x: t(lobby.wind.x), y: t(lobby.wind.y), umbrella: lobby.wind.umbrella } } : {}),
      ...(lobby.mech ? { mech: lobby.mech } : {})
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
