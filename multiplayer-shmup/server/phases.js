// The phase engine: walks a lobby through its encounter's ordered phase list
// (see encounters.js for the data shape) and runs the active phase's
// server-side behavior each tick. server.js owns the websocket protocol and
// player simulation; everything about *what the boss is doing* lives here.

// The boss wanders within these bounds during a waypointChase phase — clear
// of the bottom strip where players spawn/fight from and inset from the walls.
const CHASE_BOUNDS = { xMin: 60, xMax: 740, yMin: 70, yMax: 430 };
const CHASE_WAYPOINT_RADIUS = 20; // px; close enough counts as "arrived"

function pickChaseWaypoint() {
  return {
    x: CHASE_BOUNDS.xMin + Math.random() * (CHASE_BOUNDS.xMax - CHASE_BOUNDS.xMin),
    y: CHASE_BOUNDS.yMin + Math.random() * (CHASE_BOUNDS.yMax - CHASE_BOUNDS.yMin)
  };
}

// Boss HP scales linearly with headcount (double for 2 players, triple for
// 3, ...) so the fight stays roughly as hard per-player regardless of party
// size. Read on phase entry rather than continuously, so a player joining or
// leaving mid-phase doesn't retroactively rescale HP already in progress.
function playerCount(lobby) {
  return Math.max(1, Object.keys(lobby.players).length);
}

// HP milestone lines escalate above the phase's baseline say.intensity so
// the boss visibly unravels the closer the phase gets to ending.
const HP_TAUNT_THRESHOLDS = [75, 50, 25];
const HP_TAUNT_STEP = { 75: 1, 50: 2, 25: 3 };

// Stars are seeded inside these bounds — inset from the walls and clear of
// the very bottom so their light pools are always fully reachable.
const STAR_BOUNDS = { xMin: 60, xMax: 740, yMin: 80, yMax: 520 };

// Rounding for the non-coordinate mech values (angles, fractions): two
// decimals is plenty of precision for zone geometry and keeps the wire lean.
function r2(n) {
  return Math.round(n * 100) / 100;
}

// --- Launch codes: per-player mazes ----------------------------------------
// Bombardment's launchCodes phase drops every player into their own maze,
// each carved into its own slice of the arena so up to 6 fit on screen at
// once. Players keep using the normal movementUpdate channel (their reported
// x/y just happens to land inside their maze's slot rect); the server checks
// that reported point against the maze's walls every tick and kills on
// contact, same as any other instant-death hazard.
const MAZE_AREA = { xMin: 60, xMax: 740, yMin: 90, yMax: 560 };
const MAZE_GAP = 16; // px between adjacent maze slots
const MAZE_MARGIN = 12; // px inset between a slot's edge and its maze grid
const MAZE_MIN_CELL = 50; // px; grid size is shrunk to keep cells at least this big
const MAZE_WALL_THICKNESS = 5;
const MAZE_HIT_RADIUS = 8; // px around a wall's centerline that's lethal to touch
// cols/rows for up to 6 players, chosen to keep slots roughly square.
const MAZE_GRID_LAYOUT = { 1: [1, 1], 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [3, 2], 6: [3, 2] };

function mazeSlots(n) {
  const count = Math.max(1, Math.min(6, n));
  const [cols, rows] = MAZE_GRID_LAYOUT[count];
  const areaW = MAZE_AREA.xMax - MAZE_AREA.xMin;
  const areaH = MAZE_AREA.yMax - MAZE_AREA.yMin;
  const slotW = (areaW - MAZE_GAP * (cols - 1)) / cols;
  const slotH = (areaH - MAZE_GAP * (rows - 1)) / rows;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    slots.push({
      x: MAZE_AREA.xMin + col * (slotW + MAZE_GAP),
      y: MAZE_AREA.yMin + row * (slotH + MAZE_GAP),
      w: slotW, h: slotH
    });
  }
  return slots;
}

// Randomized-DFS ("recursive backtracker") perfect maze: every cell reachable
// from every other, exactly one path between any two — no loops to make
// dodging trivial, no isolated pockets that strand a player.
function carveMazeCells(gridSize) {
  const cells = [];
  for (let y = 0; y < gridSize; y++) {
    cells.push(Array.from({ length: gridSize }, () => ({ N: true, E: true, S: true, W: true })));
  }
  const visited = cells.map(row => row.map(() => false));
  const DIRS = [[0, -1, 'N', 'S'], [1, 0, 'E', 'W'], [0, 1, 'S', 'N'], [-1, 0, 'W', 'E']];
  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const options = DIRS
      .map(([dx, dy, a, b]) => [cx + dx, cy + dy, a, b])
      .filter(([nx, ny]) => nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize && !visited[ny][nx]);
    if (options.length === 0) { stack.pop(); continue; }
    const [nx, ny, a, b] = options[Math.floor(Math.random() * options.length)];
    cells[cy][cx][a] = false;
    cells[ny][nx][b] = false;
    visited[ny][nx] = true;
    stack.push([nx, ny]);
  }
  return cells;
}

// Builds one maze fit inside `rect`: wall segments in absolute canvas
// coordinates (ready to broadcast and to collision-check against), a start
// cell (top-left) and an exit cell (bottom-right, diagonally furthest away).
function generateMaze(rect, requestedGridSize) {
  const innerW = rect.w - MAZE_MARGIN * 2;
  const innerH = rect.h - MAZE_MARGIN * 2;
  const maxFeasible = Math.max(4, Math.floor(Math.min(innerW, innerH) / MAZE_MIN_CELL));
  const gridSize = Math.min(requestedGridSize, maxFeasible);

  const cells = carveMazeCells(gridSize);
  const cellSize = Math.min(innerW, innerH) / gridSize;
  const originX = rect.x + MAZE_MARGIN + (innerW - cellSize * gridSize) / 2;
  const originY = rect.y + MAZE_MARGIN + (innerH - cellSize * gridSize) / 2;

  // Each interior wall is shared by two cells (carved together in lockstep
  // above), so only draw it from the cell that "owns" it — N/W for every
  // cell, plus S/E only along the maze's outer bottom/right edge — instead
  // of emitting the same segment twice.
  const walls = [];
  for (let cy = 0; cy < gridSize; cy++) {
    for (let cx = 0; cx < gridSize; cx++) {
      const cell = cells[cy][cx];
      const x0 = originX + cx * cellSize, y0 = originY + cy * cellSize;
      const x1 = x0 + cellSize, y1 = y0 + cellSize;
      if (cell.N) walls.push({ x1: x0, y1: y0, x2: x1, y2: y0 });
      if (cell.W) walls.push({ x1: x0, y1: y0, x2: x0, y2: y1 });
      if (cell.S && cy === gridSize - 1) walls.push({ x1: x0, y1: y1, x2: x1, y2: y1 });
      if (cell.E && cx === gridSize - 1) walls.push({ x1: x1, y1: y0, x2: x1, y2: y1 });
    }
  }

  return {
    rect, cellSize, walls,
    start: { x: originX + cellSize * 0.5, y: originY + cellSize * 0.5 },
    exit: { x: originX + cellSize * (gridSize - 0.5), y: originY + cellSize * (gridSize - 0.5) }
  };
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t2 = lenSq > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq)) : 0;
  return Math.hypot(px - (x1 + t2 * dx), py - (y1 + t2 * dy));
}

function hitsMazeWall(maze, x, y) {
  const threshold = MAZE_WALL_THICKNESS / 2 + MAZE_HIT_RADIUS;
  return maze.walls.some(w => pointSegmentDistance(x, y, w.x1, w.y1, w.x2, w.y2) < threshold);
}

// deps:
//   say(lobby, text, intensity)        speak a boss line to the lobby
//   emit(lobby, message)               broadcast a raw message object to the lobby
//   t(n)                               round a coordinate for the wire
//   killPlayer(lobby, player, now)     kill a player outright (maze walls, timeout, ...)
function createPhaseEngine({ say, emit, t, killPlayer }) {
  function sayOneOf(lobby, lines, intensity) {
    if (lines && lines.length) say(lobby, lines[Math.floor(Math.random() * lines.length)], intensity);
  }

  // Server-side per-tick modules a phase can run, named by the phase def's
  // `behavior` field. Each gets `lobby.phaseState`, a scratch object created
  // fresh on phase entry, for anything it needs to remember between ticks.
  const BEHAVIORS = {
    stationary: {},

    // Orbits the two halves around the (inactive) boss on an ellipse and
    // enforces the kill-together window: a lone dead orb revives after
    // def.orbKillWindow ms unless its twin also falls. The ellipse keeps them
    // on screen despite the boss sitting near the top edge; the halves start
    // on opposite sides so two players can split them.
    twinOrbs: {
      onEnter(lobby, def) {
        lobby.phaseState.startedAt = Date.now();
        lobby.orbs = [0, 1].map(i => {
          const kind = def.orbKinds && def.orbKinds[i];
          const baseAngle = i === 0 ? Math.PI : 0; // sun left, moon right
          return { id: i, kind, baseAngle, x: lobby.boss.x, y: lobby.boss.y, hp: def.orbHp, maxHp: def.orbHp, deadAt: null };
        });
      },
      onExit(lobby) {
        lobby.orbs = [];
      },
      update(lobby, def, now) {
        const elapsed = (now - lobby.phaseState.startedAt) / 1000;
        const rx = def.orbitRX || 150, ry = def.orbitRY || 70;
        for (const orb of lobby.orbs) {
          const angle = orb.baseAngle + elapsed * (def.orbitSpeed || 0.7);
          orb.x = lobby.boss.x + Math.cos(angle) * rx;
          orb.y = lobby.boss.y + Math.sin(angle) * ry;
        }

        const dead = lobby.orbs.filter(o => o.hp <= 0);
        if (dead.length === 1 && now - dead[0].deadAt > def.orbKillWindow) {
          dead[0].hp = dead[0].maxHp;
          dead[0].deadAt = null;
          sayOneOf(lobby, def.say && def.say.orbsRevive, (def.say && def.say.intensity) || 0);
        }
      }
    },

    // The enrage chase: the boss roams the arena toward a wandering waypoint
    // and periodically fires shots aimed at each living player's current
    // spot. Those shots don't home in after firing, so moving away from
    // where you were when the volley fired is enough to dodge.
    waypointChase: {
      onEnter(lobby) {
        lobby.phaseState.waypoint = pickChaseWaypoint();
        lobby.phaseState.lastAimedShot = Date.now();
      },
      update(lobby, def, now, dt) {
        const state = lobby.phaseState;
        const dx = state.waypoint.x - lobby.boss.x;
        const dy = state.waypoint.y - lobby.boss.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CHASE_WAYPOINT_RADIUS) {
          state.waypoint = pickChaseWaypoint();
        } else {
          lobby.boss.x += (dx / dist) * def.chaseSpeed * dt;
          lobby.boss.y += (dy / dist) * def.chaseSpeed * dt;
        }
        lobby.boss.x = Math.max(CHASE_BOUNDS.xMin, Math.min(CHASE_BOUNDS.xMax, lobby.boss.x));
        lobby.boss.y = Math.max(CHASE_BOUNDS.yMin, Math.min(CHASE_BOUNDS.yMax, lobby.boss.y));

        // Some encounters (bombardment) opt out of the generic targeted shot
        // entirely — aimedShotInterval is absent/falsy for those.
        if (def.aimedShotInterval && now - state.lastAimedShot > def.aimedShotInterval) {
          state.lastAimedShot = now;
          const targets = Object.values(lobby.players)
            .filter(p => !p.dead)
            .map(p => ({ x: t(p.x), y: t(p.y) }));
          if (targets.length > 0) {
            emit(lobby, {
              type: 'bossAimedShot',
              origin: { x: t(lobby.boss.x), y: t(lobby.boss.y) },
              targets,
              speed: def.aimedBulletSpeed
            });
          }
        }
      }
    },

    // The sun-dominant phase: rotating rays sweep the arena, pulsing between
    // telegraph and burning, while the moon orbits as a small satellite whose
    // shadow is the safe wedge. All of it is broadcast as concrete values in
    // lobby.mech (~30 bytes/tick) rather than derived from formulas
    // client-side, for the same reason as storm's wind: every client's zones
    // must agree without clock sync. The clients evaluate/render the zones
    // and report damage taken (see the sunRays mechanic in mechanics.js).
    sunDominant: {
      onEnter(lobby) {
        lobby.phaseState.startedAt = Date.now();
        lobby.phaseState.nextFlare = Date.now() + 1500; // a beat of calm before the first flare
      },
      onExit(lobby) {
        lobby.mech = null;
      },
      update(lobby, def, now) {
        const elapsed = (now - lobby.phaseState.startedAt) / 1000;
        // Starts at 0 (rays fade in from nothing on phase entry) and pulses.
        const glow = 0.5 - 0.5 * Math.cos((elapsed * 1000 / def.glowCycleMs) * Math.PI * 2);
        const moonAngle = elapsed * def.orbitSpeed;
        lobby.mech = {
          ray: r2((elapsed * def.raySpeed) % (Math.PI * 2)),
          glow: r2(glow),
          moon: {
            x: t(lobby.boss.x + Math.cos(moonAngle) * def.orbitRadius),
            y: t(lobby.boss.y + Math.sin(moonAngle) * def.orbitRadius)
          }
        };

        // Solar flares: seeded here (like moonDominant's stars) so every
        // client sees the same wedge — the angle, width, reach, and spin all
        // roll server-side; the telegraph/burn timing runs client-side from
        // the event's arrival (see the solarFlares mechanic in mechanics.js).
        if (def.flareInterval && now >= lobby.phaseState.nextFlare) {
          lobby.phaseState.nextFlare = now + def.flareInterval;
          emit(lobby, {
            type: 'flare',
            ang: r2(Math.random() * Math.PI * 2),
            w: r2(def.flareWidthMin + Math.random() * (def.flareWidthMax - def.flareWidthMin)),
            len: t(def.flareLengthMin + Math.random() * (def.flareLengthMax - def.flareLengthMin)),
            spin: r2((Math.random() < 0.5 ? -1 : 1) * def.flareSpin * (0.7 + Math.random() * 0.6))
          });
        }
      }
    },

    // The moon-dominant phase: seeds stars at server-chosen spots so every
    // player sees the same light pools — they're shared geography the team
    // coordinates around, unlike bullets which can safely stay client-local.
    // The twinkle/explosion/light timing all runs client-side from the
    // event's arrival (see the starfield mechanic in mechanics.js). Also
    // broadcasts the moonbeam angles + a shared pulse each tick (moonbeams
    // mechanic), the same way sunDominant broadcasts its rays.
    moonDominant: {
      onEnter(lobby) {
        lobby.phaseState.startedAt = Date.now();
        lobby.phaseState.nextStar = Date.now() + 800;
        lobby.phaseState.pools = []; // recently-seeded stars, for the safe-spawn bias
      },
      onExit(lobby) {
        lobby.mech = null;
      },
      update(lobby, def, now) {
        const state = lobby.phaseState;
        const elapsed = (now - state.startedAt) / 1000;

        // Moonbeams: evenly spaced angles all sweeping together, plus a shared
        // telegraph→active pulse (harmful only near the top of the cycle).
        const count = def.moonbeamCount || 2;
        const beams = [];
        for (let i = 0; i < count; i++) {
          beams.push(r2((i * (Math.PI * 2 / count) + elapsed * (def.moonbeamSpeed || 0.4)) % (Math.PI * 2)));
        }
        const glow = 0.5 - 0.5 * Math.cos((elapsed * 1000 / (def.moonbeamGlowCycleMs || 3200)) * Math.PI * 2);
        lobby.mech = { beams, glow: r2(glow) };

        if (now < state.nextStar) return;
        state.nextStar = now + def.starInterval;

        // Bias new stars toward existing safe pools so the light isn't a pure
        // refuge — the explosion is telegraphed client-side (starBlastRadius),
        // so players in a pool get warning to step aside. Pool light timing
        // mirrors the client's starLightRadius, read from the starfield params.
        const sp = (def.mechanics.find(m => m.mechanic === 'starfield') || {}).params || {};
        state.pools = state.pools.filter(p => now - p.spawn < sp.twinkleMs + sp.lightMs);
        const litPools = state.pools.filter(p => {
          const lightAge = now - p.spawn - sp.twinkleMs;
          return lightAge > 0 && lightAge < sp.lightMs;
        });

        let x, y;
        if (litPools.length && Math.random() < (def.starFavorSafe || 0)) {
          const pool = litPools[Math.floor(Math.random() * litPools.length)];
          const lightAge = now - pool.spawn - sp.twinkleMs;
          const r = sp.lightRadius * (1 - lightAge / sp.lightMs) * 0.55; // land well inside the lit area
          const a = Math.random() * Math.PI * 2, d = Math.random() * r;
          x = Math.max(STAR_BOUNDS.xMin, Math.min(STAR_BOUNDS.xMax, pool.x + Math.cos(a) * d));
          y = Math.max(STAR_BOUNDS.yMin, Math.min(STAR_BOUNDS.yMax, pool.y + Math.sin(a) * d));
        } else {
          x = STAR_BOUNDS.xMin + Math.random() * (STAR_BOUNDS.xMax - STAR_BOUNDS.xMin);
          y = STAR_BOUNDS.yMin + Math.random() * (STAR_BOUNDS.yMax - STAR_BOUNDS.yMin);
        }
        state.pools.push({ x, y, spawn: now });
        emit(lobby, { type: 'star', x: t(x), y: t(y) });
      }
    },

    // Launch codes: one maze per player, teleported to their maze's start on
    // entry. Every tick checks each living, not-yet-finished player's current
    // (self-reported) position against their own maze's walls, and against
    // their exit. If everyone clears their maze the phase advances early;
    // if the clock runs out with anyone still inside, the whole party dies.
    launchCodes: {
      onEnter(lobby, def) {
        const state = lobby.phaseState;
        // The maze clock and wall collisions don't start until the grace
        // period ends (state.startedAt stays null until then) — players get
        // def.graceMs to see their layout before it turns lethal.
        state.graceUntil = Date.now() + (def.graceMs || 0);
        state.startedAt = null;
        state.reached = new Set();
        state.resolved = false;

        const ids = Object.keys(lobby.players).map(Number).sort((a, b) => a - b);
        const slots = mazeSlots(ids.length);
        state.mazes = {};
        state.trackedIds = ids;
        ids.forEach((id, i) => {
          const maze = generateMaze(slots[i], def.gridSize);
          state.mazes[id] = maze;
          const p = lobby.players[id];
          p.x = maze.start.x;
          p.y = maze.start.y;
        });

        emit(lobby, {
          type: 'mazeLayout',
          timeLimit: def.timeLimit,
          mazes: Object.fromEntries(ids.map(id => {
            const m = state.mazes[id];
            return [id, {
              rect: m.rect,
              cellSize: r2(m.cellSize),
              walls: m.walls.map(w => ({ x1: t(w.x1), y1: t(w.y1), x2: t(w.x2), y2: t(w.y2) })),
              start: { x: t(m.start.x), y: t(m.start.y) },
              exit: { x: t(m.exit.x), y: t(m.exit.y) }
            }];
          }))
        });
      },
      onExit(lobby) {
        lobby.phaseState.mazes = null;
      },
      update(lobby, def, now) {
        const state = lobby.phaseState;
        if (state.resolved) return;

        if (now < state.graceUntil) {
          lobby.mech = { mazeGraceLeft: state.graceUntil - now };
          return; // walls aren't lethal yet and the clock hasn't started
        }
        if (state.startedAt === null) state.startedAt = now;

        for (const id of state.trackedIds) {
          const p = lobby.players[id];
          if (!p || p.dead || state.reached.has(id)) continue;
          const maze = state.mazes[id];
          if (hitsMazeWall(maze, p.x, p.y)) {
            killPlayer(lobby, p, now);
            continue;
          }
          if (Math.hypot(p.x - maze.exit.x, p.y - maze.exit.y) < maze.cellSize * 0.4) {
            state.reached.add(id);
          }
        }

        if (state.trackedIds.every(id => state.reached.has(id))) {
          state.resolved = true;
          trigger(lobby, 'mazeCleared');
          return;
        }

        const elapsed = now - state.startedAt;
        lobby.mech = { mazeTimeLeft: Math.max(0, def.timeLimit - elapsed) };
        if (elapsed > def.timeLimit) {
          state.resolved = true;
          sayOneOf(lobby, def.say && def.say.timeout, (def.say && def.say.intensity) || 0);
          emit(lobby, { type: 'mazeTimeout' });
          for (const id of state.trackedIds) {
            const p = lobby.players[id];
            if (p && !p.dead) killPlayer(lobby, p, now);
          }
        }
      }
    },

    // The eclipse: broadcasts how far the moon has slid over the sun (0..1).
    // Clients animate the disc from it and trigger the totality blind flash
    // the moment it reaches 1 — the phase transition plus this one fraction
    // is all the synchronization the whole sequence needs.
    converge: {
      onEnter(lobby) {
        lobby.phaseState.startedAt = Date.now();
      },
      onExit(lobby) {
        lobby.mech = null;
      },
      update(lobby, def, now) {
        lobby.mech = { moonT: r2(Math.min(1, (now - lobby.phaseState.startedAt) / def.convergeMs)) };
      }
    }
  };

  function currentPhase(lobby) {
    return lobby.encounter.phases[lobby.phaseIndex];
  }

  // Moves the lobby into phases[index]: runs the outgoing behavior's onExit,
  // grants the phase's fresh (per-player-scaled) boss HP pool if it has one,
  // runs the new behavior's onEnter, and speaks the phase's entry line.
  // `silent` suppresses that line — encounter resets speak their own.
  function enterPhase(lobby, index, { silent = false } = {}) {
    const prev = currentPhase(lobby);
    const prevBehavior = BEHAVIORS[prev.behavior];
    if (prevBehavior && prevBehavior.onExit) prevBehavior.onExit(lobby, prev);

    const def = lobby.encounter.phases[index];
    lobby.phaseIndex = index;
    lobby.phaseState = {};
    lobby.mech = null; // per-tick mechanic broadcast; the new behavior repopulates it if it has one
    if (def.bossHp != null) {
      lobby.boss.maxHp = def.bossHp * playerCount(lobby);
      lobby.boss.hp = lobby.boss.maxHp;
    }

    const behavior = BEHAVIORS[def.behavior];
    if (behavior && behavior.onEnter) behavior.onEnter(lobby, def);
    if (!silent && def.say) sayOneOf(lobby, def.say.enter, def.say.intensity || 0);
  }

  function advancePhase(lobby) {
    if (lobby.phaseIndex + 1 < lobby.encounter.phases.length) {
      enterPhase(lobby, lobby.phaseIndex + 1);
    }
  }

  // A gameplay event that might end the current phase ('bossHpZero',
  // 'orbsDead'). Only advances if it's the event this phase transitions on.
  function trigger(lobby, event) {
    if (currentPhase(lobby).transition === event) advancePhase(lobby);
  }

  // Runs the active phase's behavior for one tick.
  function update(lobby, now, dt) {
    const def = currentPhase(lobby);
    const behavior = BEHAVIORS[def.behavior];
    if (behavior && behavior.update) behavior.update(lobby, def, now, dt);
  }

  // Checks the boss's current HP against the 75/50/25% milestones for the
  // active phase and fires (once each per run, tracked in lobby.hpTaunts)
  // the first time HP crosses under one. Call after any change to boss HP.
  function checkHpTaunts(lobby) {
    const def = currentPhase(lobby);
    const hpLines = def.say && def.say.hp;
    if (!hpLines) return;

    const pct = (lobby.boss.hp / (lobby.boss.maxHp || 1)) * 100;
    for (const threshold of HP_TAUNT_THRESHOLDS) {
      const key = `${def.id}-${threshold}`;
      if (pct > threshold || lobby.hpTaunts.has(key)) continue;
      lobby.hpTaunts.add(key);
      sayOneOf(lobby, hpLines[threshold], ((def.say && def.say.intensity) || 0) + HP_TAUNT_STEP[threshold]);
    }
  }

  return { currentPhase, enterPhase, advancePhase, trigger, update, checkHpTaunts };
}

export { createPhaseEngine };
