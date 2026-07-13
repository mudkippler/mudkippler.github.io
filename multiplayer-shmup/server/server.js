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
// Movement is scaled by measured elapsed time each tick (see gameLoop), not
// a fixed per-tick step — setInterval isn't precise under load (multiple
// lobbies, GC pauses), and a fixed-per-tick step would silently run slower
// or faster than real time, drifting away from the client's own prediction
// (which scales by requestAnimationFrame's real dt). That drift is what
// every other player would see as a desynced position.
const PLAYER_SPEED_PER_SEC = 150; // matches the client's prediction speed
const PLAYER_BULLET_SPEED = 5; // matches the client's bullet speed, used to clamp relayed aim vectors
const BULLET_DAMAGE = 10; // fixed, server-defined so clients can't self-report arbitrary damage
const MISSILE_DAMAGE = 35; // bombardment explosions hit harder than a regular boss bullet
const LIGHTNING_DAMAGE = 25; // storm's lightning strikes, between a regular bullet and a missile
const WIND_MAX_STRENGTH = 120; // px/sec, storm's strongest gusts (see the wind block in gameLoop)
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

// Encounter definitions. bossMaxHp/hasOrbPhase/chase* are authoritative here;
// the attack fields are forwarded to clients, which simulate boss bullets
// locally. Every encounter ends with a phase-3 "enrage" chase: the boss
// becomes mobile and periodically fires shots aimed at each living player's
// current position (see startChasePhase / gameLoop), on top of its usual
// ring pattern which keeps firing from wherever the boss currently is.
const ENCOUNTERS = {
  twin: {
    id: 'twin', name: 'The Twin Guardian',
    bossMaxHp: 2500, hasOrbPhase: true,
    attackRate: 100, numberOfAngles: 4, bulletSpeed: 1, bigRedChance: 0.1,
    chaseMaxHp: 800, chaseSpeed: 70, aimedShotInterval: 1400, aimedBulletSpeed: 3.2
  },
  // Slanting rain + telegraphed lightning strikes (see lightningAttack in
  // attacks.js) instead of the default ring, plus wind that continuously
  // pushes players around (see the wind block in gameLoop) — the rain's
  // sideways drift follows the same wind vector so the whole sky visibly
  // leans with the gusts.
  storm: {
    id: 'storm', name: 'Bullet Storm', pattern: 'storm',
    bossMaxHp: 3500, hasOrbPhase: false,
    attackRate: 55, drops: 5, bulletSpeed: 2.4, bigRedChance: 0,
    chaseMaxHp: 600, chaseSpeed: 90, aimedShotInterval: 1000, aimedBulletSpeed: 3.6
  },
  blitz: {
    id: 'blitz', name: 'Blitz',
    bossMaxHp: 1500, hasOrbPhase: false,
    attackRate: 55, numberOfAngles: 4, bulletSpeed: 2, bigRedChance: 0.05,
    chaseMaxHp: 300, chaseSpeed: 110, aimedShotInterval: 800, aimedBulletSpeed: 4.2
  },
  // The three below each have a signature bullet pattern instead of the
  // default rotating ring; `pattern` selects the attack in the client's
  // updateLocalCombat and the extra fields are that pattern's knobs.
  helix: {
    id: 'helix', name: 'The Helix', pattern: 'spiral',
    bossMaxHp: 2000, hasOrbPhase: false,
    attackRate: 60, arms: 3, bulletSpeed: 1.6, bigRedChance: 0,
    chaseMaxHp: 500, chaseSpeed: 80, aimedShotInterval: 1200, aimedBulletSpeed: 3.4
  },
  tide: {
    id: 'tide', name: 'Tidal Warden', pattern: 'wave',
    bossMaxHp: 2200, hasOrbPhase: false,
    attackRate: 90, fanCount: 5, bulletSpeed: 1.8, bigRedChance: 0,
    chaseMaxHp: 600, chaseSpeed: 75, aimedShotInterval: 1100, aimedBulletSpeed: 3.4
  },
  rain: {
    id: 'rain', name: 'Acid Rain', pattern: 'rain',
    bossMaxHp: 1800, hasOrbPhase: false,
    attackRate: 45, drops: 3, bulletSpeed: 2.2, bigRedChance: 0,
    chaseMaxHp: 500, chaseSpeed: 95, aimedShotInterval: 900, aimedBulletSpeed: 3.8
  },
  bombardment: {
    id: 'bombardment', name: 'Bombardment', pattern: 'bombardment',
    bossMaxHp: 5000, hasOrbPhase: false,
    // attackRate is the gap between volleys, not between missiles within one
    // — each volley is itself an extended sequence of telegraphed impacts
    // (see bombardmentAttack in attacks.js), so this stays a slower cadence
    // than the other patterns' per-bullet rate.
    attackRate: 1400, bigRedChance: 0,
    // No aimedShotInterval: bombardment's own escalating missile volleys
    // already carry the phase-3 enrage, so the generic single targeted shot
    // every other encounter gets is redundant here (see the phase-3 block in
    // gameLoop, which skips firing it when this is falsy).
    chaseMaxHp: 600, chaseSpeed: 85
  }
};

// The boss wanders within these bounds during the chase phase — clear of the
// bottom strip where players spawn/fight from and inset from the walls.
const CHASE_BOUNDS = { xMin: 60, xMax: 740, yMin: 70, yMax: 430 };
const CHASE_WAYPOINT_RADIUS = 20; // px; close enough counts as "arrived"

function pickChaseWaypoint() {
  return {
    x: CHASE_BOUNDS.xMin + Math.random() * (CHASE_BOUNDS.xMax - CHASE_BOUNDS.xMin),
    y: CHASE_BOUNDS.yMin + Math.random() * (CHASE_BOUNDS.yMax - CHASE_BOUNDS.yMin)
  };
}

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
    paused: false, // host-toggled; freezes simulation but keeps state broadcasts flowing
    emptyAt: null,
    wipeAt: null, // set when every player is dead; encounter resets shortly after
    players: {},
    boss: { x: 400, y: 100, radius: 30, hp: encounter.bossMaxHp, maxHp: encounter.bossMaxHp },
    // 1: boss health bar, 2: twin orbs (co-op check, twin only), 3: enrage
    // chase (mobile boss + aimed shots), 4: defeated
    phase: 1,
    orbs: [], // {id, baseX, baseY, x, y, hp, maxHp, deadAt}
    chase: null, // {waypoint: {x,y}, lastAimedShot} — set on entering phase 3
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

// Per-encounter dialogue at HP milestones, reused for both the main fight
// (phase 1) and the phase-3 enrage chase — enrage gets more lines per
// threshold and higher intensity (see HP_TAUNT_INTENSITY) so the boss visibly
// unravels the closer it gets to death. `phase1[100]`/`enrage[100]` fire once
// on entering that phase; 75/50/25 fire the first time HP crosses under them.
const BOSS_LINES = {
  twin: {
    phase1: {
      100: ["Two blades, one purpose. Let's dance."],
      75: ["You're better than I expected."],
      50: ["Impressive. Truly."],
      25: ["...you're actually hurting me."]
    },
    enrage: {
      75: ["I said ENOUGH!", "Both blades. No mercy now."],
      50: ["I WILL NOT FALL TO THIS!", "Stand still and DIE!"],
      25: ["This... isn't... POSSIBLE—", "I REFUSE! I REFUSE!!", "*the blades scream with him*"]
    }
  },
  storm: {
    phase1: {
      100: ['Let the storm begin.'],
      75: ['Just a drizzle so far.'],
      50: ["Now you'll feel the real storm."],
      25: ['The sky itself trembles...']
    },
    enrage: {
      75: ['THUNDER ANSWERS ME!', 'You woke the storm, fool!'],
      50: ['I AM THE STORM!', 'NOWHERE TO HIDE NOW!'],
      25: ['t-the storm... is breaking apart—', 'NO! NO!! NOOOO!', '*lightning crackles wildly*']
    }
  },
  blitz: {
    phase1: {
      100: ['Fast. Furious. Fatal. Try to keep up.'],
      75: ['Too slow!'],
      50: ['Getting warmer, aren’t I?'],
      25: ['Alright — no more playing around.']
    },
    enrage: {
      75: ['FULL THROTTLE!', "Burn faster than you can blink!"],
      50: ["I'M UNSTOPPABLE!!", 'CAN’T. CATCH. ME.'],
      25: ["m-my flame's... flickering—", "I WON'T BURN OUT HERE!", '*the fire roars unevenly*']
    }
  },
  helix: {
    phase1: {
      100: ['Round and round you’ll go.'],
      75: ['Dizzy yet?'],
      50: ['The spiral tightens.'],
      25: ["You're unraveling me..."]
    },
    enrage: {
      75: ['THE PATTERN BREAKS FREE!', 'Spin with me — FOREVER!'],
      50: ['I AM THE VORTEX!', 'EVERYTHING FALLS INWARD!'],
      25: ["the spiral's... collapsing—", 'HOLD TOGETHER, HOLD—', '*reality warps and stutters*']
    }
  },
  tide: {
    phase1: {
      100: ['The tide answers to no one.'],
      75: ['A ripple, nothing more.'],
      50: ['The waters rise against you.'],
      25: ["You've breached the seawall..."]
    },
    enrage: {
      75: ['THE FLOOD COMES FOR YOU!', 'Drown in my fury!'],
      50: ['I AM THE DEEP ITSELF!', 'THE TIDE NEVER STOPS!'],
      25: ['the waters... are receding—', 'NO! STAY! STAY WITH ME!', '*the tide howls and crashes*']
    }
  },
  rain: {
    phase1: {
      100: ['Hope you brought an umbrella.'],
      75: ['Just the first drops.'],
      50: ['It burns more with every drop, doesn’t it?'],
      25: ['The clouds are thinning...']
    },
    enrage: {
      75: ['A DOWNPOUR OF PAIN!', 'Let it ALL corrode!'],
      50: ['I AM THE STORMCLOUD!', 'NOTHING SURVIVES THE RAIN!'],
      25: ['the clouds... are dissolving—', "I WON'T DRY UP! I WON'T!", '*the acid hisses erratically*']
    }
  },
  bombardment: {
    phase1: {
      100: ['Brace yourselves. Impact incoming.'],
      75: ['First volley — barely a scratch.'],
      50: ['Auxiliary silos online - doubling payloads.'],
      25: ["Disable safety protocols."]
    },
    enrage: {
      75: ['FULL BOMBARDMENT — NO SURVIVORS!', "Everything I've got. NOW!"],
      50: ["I WON'T STOP FIRING!!", 'SATURATE THE FIELD!'],
      25: ["m-my arsenal's... failing—", 'ONE MORE VOLLEY! JUST ONE MORE!', 'AHAHAHAHAHAHAH!!!!']
    }
  }
};
const DEFAULT_BOSS_LINES = {
  phase1: { 100: ["Let's begin."], 75: ['Not bad.'], 50: ["You're doing well."], 25: ["I'm actually struggling..."] },
  enrage: {
    75: ['ENOUGH OF THIS!', 'No more holding back!'],
    50: ["I WON'T LOSE HERE!", 'MOVE, MOVE, MOVE—'],
    25: ["n-no... this can't—", 'I REFUSE TO FALL!!', '*a scream of static and rage*']
  }
};

// 1 (barely rattled) through 6 (total meltdown) — drives the client's
// escalating dialogue-box styling (font/color/size/shake).
const HP_TAUNT_INTENSITY = { 'phase1-75': 1, 'phase1-50': 2, 'phase1-25': 3, 'enrage-75': 4, 'enrage-50': 5, 'enrage-25': 6 };

// Fires the encounter's line for the phase's 100% milestone (call once, right
// as phase 1 or the enrage chase begins).
function bossSayPhaseStart(lobby, phaseKey) {
  const pool = (BOSS_LINES[lobby.encounter.id] || DEFAULT_BOSS_LINES)[phaseKey];
  const lines = pool && pool[100];
  if (lines && lines.length) bossSay(lobby, lines[Math.floor(Math.random() * lines.length)], phaseKey === 'enrage' ? 3 : 0);
}

// Checks the boss's current HP against the 75/50/25% milestones for whichever
// phase it's currently in and fires (once each) the first time HP crosses
// under one. Call after any change to lobby.boss.hp during phase 1 or 3.
function checkHpTaunts(lobby) {
  const phaseKey = lobby.phase === 3 ? 'enrage' : lobby.phase === 1 ? 'phase1' : null;
  if (!phaseKey) return;
  const pct = (lobby.boss.hp / (lobby.boss.maxHp || 1)) * 100;
  const pool = (BOSS_LINES[lobby.encounter.id] || DEFAULT_BOSS_LINES)[phaseKey];
  for (const threshold of [75, 50, 25]) {
    const key = `${phaseKey}-${threshold}`;
    if (pct > threshold || lobby.hpTaunts.has(key)) continue;
    lobby.hpTaunts.add(key);
    const lines = pool && pool[threshold];
    if (lines && lines.length) bossSay(lobby, lines[Math.floor(Math.random() * lines.length)], HP_TAUNT_INTENSITY[key]);
  }
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

// Boss HP scales linearly with headcount (double for 2 players, triple for
// 3, ...) so the fight stays roughly as hard per-player regardless of party
// size. Read at each phase transition (fight start, restart, entering the
// enrage chase) rather than continuously, so a player joining/leaving
// mid-fight doesn't retroactively rescale HP already in progress.
function playerCount(lobby) {
  return Math.max(1, Object.keys(lobby.players).length);
}

// Resets an in-progress or finished encounter back to phase 1 with full boss
// HP and every player alive at full health. Used both for the automatic
// team-wipe recovery and a host-triggered restart after victory.
function resetEncounter(lobby) {
  lobby.wipeAt = null;
  lobby.boss.x = 400;
  lobby.boss.y = 100;
  lobby.boss.maxHp = lobby.encounter.bossMaxHp * playerCount(lobby); // chase phase may have shrunk this
  lobby.boss.hp = lobby.boss.maxHp;
  lobby.phase = 1;
  lobby.orbs = [];
  lobby.chase = null;
  lobby.hpTaunts = new Set();
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

function startPhase2(lobby) {
  lobby.phase = 2;
  lobby.orbs = [0, 1].map(i => {
    const x = lobby.boss.x + (i === 0 ? -150 : 150);
    const y = lobby.boss.y + 50;
    return { id: i, baseX: x, baseY: y, x, y, hp: ORB_MAX_HP, maxHp: ORB_MAX_HP, deadAt: null };
  });
  bossSay(lobby, "i'm just getting started..");
}

// Phase 3: the boss's last stand. It gets a fresh HP pool, starts roaming
// the arena instead of sitting still, and periodically fires shots aimed at
// each living player's position on top of its usual ring pattern.
function startChasePhase(lobby, taunt) {
  lobby.phase = 3;
  lobby.orbs = [];
  lobby.boss.maxHp = lobby.encounter.chaseMaxHp * playerCount(lobby);
  lobby.boss.hp = lobby.boss.maxHp;
  lobby.chase = { waypoint: pickChaseWaypoint(), lastAimedShot: Date.now() };
  bossSay(lobby, taunt, 3);
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
    encounter: lobby.encounter,
    boss: { ...lobby.boss, x: t(lobby.boss.x), y: t(lobby.boss.y) },
    graves: lobby.graves,
    phase: lobby.phase,
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
        // Scale HP for however many players are actually here now — createLobby
        // set it assuming just the host, since others may have joined since.
        lobby.boss.maxHp = lobby.encounter.bossMaxHp * playerCount(lobby);
        lobby.boss.hp = lobby.boss.maxHp;
        broadcastLobbyState(lobby);
        lobbyBroadcast(lobby, serialize({ type: 'gameStart' }));
        bossSayPhaseStart(lobby, 'phase1');
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
        lobbyBroadcast(lobby, serialize({ type: 'encounterChanged', encounter: lobby.encounter }));
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
          const windSlack = lobby.encounter.pattern === 'storm' ? WIND_MAX_STRENGTH * elapsed * 1.5 : 0;
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
        // Damageable in phase 1 (main fight) and phase 3 (enrage chase);
        // invulnerable during the orb phase and once already defeated.
        if (!lobby.started || (lobby.phase !== 1 && lobby.phase !== 3)) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        lobby.boss.hp = Math.max(0, lobby.boss.hp - BULLET_DAMAGE);
        lobby.damageLog[ws.id].dmg += BULLET_DAMAGE;
        checkHpTaunts(lobby);

        if (lobby.boss.hp <= 0) {
          if (lobby.phase === 3) {
            lobby.phase = 4;
            lobby.chase = null;
            bossSay(lobby, 'impossible... you actually got me...');
          } else if (lobby.encounter.hasOrbPhase) {
            startPhase2(lobby);
          } else {
            startChasePhase(lobby, "you think that's the end of me?!");
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
            startChasePhase(lobby, 'impossible... you struck as one... but I am not finished!');
          }
        }
      } else if (data.type === 'playerDamage') {
        if (!lobby.started || player.dead) return;
        const now = Date.now();
        if (now - player.lastDamageReport < DAMAGE_REPORT_MIN_INTERVAL) return;
        player.lastDamageReport = now;

        // The client only reports *that* it was hit and by what — the amount
        // is still fixed server-side per source so a client can't self-report
        // arbitrary damage.
        const damage = data.source === 'missile' ? MISSILE_DAMAGE : data.source === 'lightning' ? LIGHTNING_DAMAGE : BULLET_DAMAGE;
        player.health -= damage;
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
      // needing clock sync. Only relevant during the main fight/enrage chase.
      if (lobby.encounter.pattern === 'storm' && (lobby.phase === 1 || lobby.phase === 3)) {
        const wt = now / 1000;
        const windAngle = Math.sin(wt * 0.15) * 1.0 + Math.sin(wt * 0.37) * 0.4;
        const gust = Math.pow(0.5 + 0.5 * Math.sin(wt * 0.5), 6); // occasional strong pulses, mostly calm between
        const windStrength = 30 + gust * (WIND_MAX_STRENGTH - 30);
        lobby.wind = { x: Math.cos(windAngle) * windStrength, y: Math.sin(windAngle) * windStrength * 0.15 };
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

      // Phase 3: the boss roams the arena toward a wandering waypoint and
      // periodically fires shots aimed at each living player's current spot.
      // Those shots don't home in after firing, so moving away from where you
      // were when the volley fired is enough to dodge.
      if (lobby.phase === 3 && lobby.chase) {
        const chase = lobby.chase;
        const dx = chase.waypoint.x - lobby.boss.x;
        const dy = chase.waypoint.y - lobby.boss.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CHASE_WAYPOINT_RADIUS) {
          chase.waypoint = pickChaseWaypoint();
        } else {
          lobby.boss.x += (dx / dist) * lobby.encounter.chaseSpeed * dt;
          lobby.boss.y += (dy / dist) * lobby.encounter.chaseSpeed * dt;
        }
        lobby.boss.x = Math.max(CHASE_BOUNDS.xMin, Math.min(CHASE_BOUNDS.xMax, lobby.boss.x));
        lobby.boss.y = Math.max(CHASE_BOUNDS.yMin, Math.min(CHASE_BOUNDS.yMax, lobby.boss.y));

        // Some encounters (bombardment) opt out of the generic targeted shot
        // entirely — aimedShotInterval is absent/falsy for those.
        if (lobby.encounter.aimedShotInterval && now - chase.lastAimedShot > lobby.encounter.aimedShotInterval) {
          chase.lastAimedShot = now;
          const targets = Object.values(lobby.players)
            .filter(p => !p.dead)
            .map(p => ({ x: t(p.x), y: t(p.y) }));
          if (targets.length > 0) {
            lobbyBroadcast(lobby, serialize({
              type: 'bossAimedShot',
              origin: { x: t(lobby.boss.x), y: t(lobby.boss.y) },
              targets,
              speed: lobby.encounter.aimedBulletSpeed
            }));
          }
        }
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
      orbs: publicOrbs(lobby),
      paused: lobby.paused,
      // Omitted entirely outside storm's wind-active phases to save bytes on
      // every other encounter/lobby's per-tick broadcast.
      ...(lobby.wind ? { wind: { x: t(lobby.wind.x), y: t(lobby.wind.y) } } : {})
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
