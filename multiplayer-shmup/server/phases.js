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

// deps:
//   say(lobby, text, intensity)  speak a boss line to the lobby
//   emit(lobby, message)         broadcast a raw message object to the lobby
//   t(n)                         round a coordinate for the wire
function createPhaseEngine({ say, emit, t }) {
  function sayOneOf(lobby, lines, intensity) {
    if (lines && lines.length) say(lobby, lines[Math.floor(Math.random() * lines.length)], intensity);
  }

  // Server-side per-tick modules a phase can run, named by the phase def's
  // `behavior` field. Each gets `lobby.phaseState`, a scratch object created
  // fresh on phase entry, for anything it needs to remember between ticks.
  const BEHAVIORS = {
    stationary: {},

    // Bobs the orbs and enforces the kill-together window: a lone dead orb
    // revives after def.orbKillWindow ms unless its twin also falls.
    twinOrbs: {
      onEnter(lobby, def) {
        lobby.orbs = [0, 1].map(i => {
          const x = lobby.boss.x + (i === 0 ? -150 : 150);
          const y = lobby.boss.y + 50;
          const kind = def.orbKinds && def.orbKinds[i];
          return { id: i, kind, baseX: x, baseY: y, x, y, hp: def.orbHp, maxHp: def.orbHp, deadAt: null };
        });
      },
      onExit(lobby) {
        lobby.orbs = [];
      },
      update(lobby, def, now) {
        for (const orb of lobby.orbs) {
          orb.y = orb.baseY + Math.sin(now / 400 + orb.id * Math.PI) * 15;
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
      }
    },

    // The moon-dominant phase: seeds stars at server-chosen spots so every
    // player sees the same light pools — they're shared geography the team
    // coordinates around, unlike bullets which can safely stay client-local.
    // The twinkle/explosion/light timing all runs client-side from the
    // event's arrival (see the starfield mechanic in mechanics.js).
    moonDominant: {
      onEnter(lobby) {
        lobby.phaseState.nextStar = Date.now() + 800;
      },
      update(lobby, def, now) {
        if (now < lobby.phaseState.nextStar) return;
        lobby.phaseState.nextStar = now + def.starInterval;
        emit(lobby, {
          type: 'star',
          x: t(STAR_BOUNDS.xMin + Math.random() * (STAR_BOUNDS.xMax - STAR_BOUNDS.xMin)),
          y: t(STAR_BOUNDS.yMin + Math.random() * (STAR_BOUNDS.yMax - STAR_BOUNDS.yMin))
        });
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

module.exports = { createPhaseEngine };
