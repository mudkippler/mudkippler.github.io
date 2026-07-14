// Encounter definitions: every boss fight is an ordered list of phases that
// the phase engine (see phases.js) walks the lobby through. The whole
// structure minus the dialogue tables is forwarded to clients on join (see
// publicEncounter in server.js) so they drive their local attack simulation
// (public/mechanics.js) and UI from the same data the server runs.
//
// Phase fields:
//   id               stable key — HP-taunt tracking and tests reference
//                    phases by id, never by index
//   bossHp           fresh boss HP pool granted on entering the phase,
//                    scaled per player (see enterPhase in phases.js); omit
//                    to carry the previous phase's HP across (e.g. the orb
//                    phase keeps the depleted bar at 0)
//   bossDamageable   bossDamage reports apply during this phase
//   orbsDamageable   orbDamage reports apply during this phase
//   behavior         server-side per-tick module (see BEHAVIORS in
//                    phases.js); its knobs (chaseSpeed, orbHp, ...) sit as
//                    sibling fields on the phase
//   wind             server computes the storm wind vector this phase
//   mechanic         client-side attack module (see MECHANICS in
//                    public/mechanics.js)
//   params           that mechanic's knobs, forwarded to clients
//   transition       event that advances to the next phase: 'bossHpZero'
//                    (boss HP depleted) or 'orbsDead' (all orbs down within
//                    the kill window); omit on terminal phases
//   portrait         fixed portrait state for this phase ('enraged',
//                    'defeat'); omit to derive base/injured from current HP
//   bossTint         boss body color override on the canvas
//   subtitle         boss-bar subtitle while the phase is active
//   victory          marks the "players won" terminal phase
//   say              dialogue, server-only (stripped before forwarding):
//                      enter      lines when the phase begins
//                      hp         lines the first time HP crosses under
//                                 75/50/25%
//                      orbsRevive lines when a lone dead orb revives
//                      intensity  the phase's baseline for the dialogue-box
//                                 styling (0 calm … 6 meltdown); HP
//                                 milestone lines escalate +1/+2/+3 above it

// Every encounter ends with the same two beats: a phase-3-style "enrage"
// chase (mobile boss, fresh HP pool, aimed shots — see waypointChase in
// phases.js) and the terminal defeated phase.
const ENRAGE_BASE = {
  id: 'enrage',
  bossDamageable: true,
  behavior: 'waypointChase',
  transition: 'bossHpZero',
  portrait: 'enraged',
  bossTint: '#a33',
  subtitle: 'Enraged'
};

const DEFEATED = {
  id: 'defeated',
  victory: true,
  mechanic: 'none',
  portrait: 'defeat',
  subtitle: 'Defeated',
  say: { enter: ['impossible... you actually got me...'] }
};

// The standard enrage entry line for bosses whose main phase feeds straight
// into the chase; twin overrides it since its enrage follows the orb phase.
const ENRAGE_ENTER = "you think that's the end of me?!";

// Attack params shared by an encounter's main and enrage phases — the enrage
// chase keeps firing the boss's signature pattern from wherever it roams.
const TWIN_RING = { attackRate: 100, numberOfAngles: 4, bulletSpeed: 1, bigRedChance: 0.1 };
const STORM_RAIN = { attackRate: 45, drops: 9, bulletSpeed: 2.6 };
const BLITZ_RING = { attackRate: 55, numberOfAngles: 4, bulletSpeed: 2, bigRedChance: 0.05 };
const HELIX_SPIRAL = { attackRate: 60, arms: 3, bulletSpeed: 1.6 };
const TIDE_WAVE = { attackRate: 90, fanCount: 5, bulletSpeed: 1.8 };
const RAIN_DROPS = { attackRate: 45, drops: 3, bulletSpeed: 2.2 };
// attackRate is the gap between volleys, not between missiles within one —
// each volley is itself an extended sequence of telegraphed impacts (see
// bombardmentAttack in attacks.js), so this stays a slower cadence than the
// other patterns' per-bullet rate.
const BOMBARDMENT_VOLLEYS = { attackRate: 1400 };

const ENCOUNTERS = {
  twin: {
    id: 'twin', name: 'The Twin Guardian',
    phases: [
      {
        id: 'main',
        bossHp: 1000, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'ring', params: TWIN_RING,
        transition: 'bossHpZero',
        say: {
          enter: ["Two blades, one purpose. Let's dance."],
          hp: {
            75: ["You're better than I expected."],
            50: ['Impressive. Truly.'],
            25: ["...you're actually hurting me."]
          }
        }
      },
      {
        // Co-op check: both orbs must die within orbKillWindow of each other
        // or the dead one revives. Orb HP is sized so one player at max
        // reported DPS (BULLET_DAMAGE per DAMAGE_REPORT_MIN_INTERVAL = 200/s)
        // needs ~1.5s per orb — killing both sequentially can't fit the
        // window, so it takes two players focusing different orbs.
        id: 'orbs',
        orbsDamageable: true,
        behavior: 'twinOrbs', orbHp: 200, orbKillWindow: 3000,
        orbKinds: ['sun', 'moon'], // rendered gold/silver — they foreshadow the phases that follow
        mechanic: 'orbRings', params: { attackRate: 200, numberOfAngles: 4, bulletSpeed: 1 },
        transition: 'orbsDead',
        subtitle: 'Destroy the sun and moon — together',
        say: {
          enter: ["i'm just getting started.."],
          orbsRevive: ['you must strike them down together!']
        }
      },
      {
        // The sun takes over the main body. Rotating rays sweep the arena,
        // pulsing between harmless telegraph and burning — the moon keeps
        // orbiting as a small satellite whose shadow cuts a safe wedge
        // through them. The server broadcasts the ray angle / glow / moon
        // position each tick (see sunDominant in phases.js) so every
        // client's zones agree without clock sync.
        id: 'sun',
        bossHp: 400, bossDamageable: true,
        behavior: 'sunDominant',
        raySpeed: 0.22, // rad/s the rays sweep around the sun
        glowCycleMs: 5200, // one full fade-in/fade-out pulse of the rays
        orbitRadius: 140, orbitSpeed: 0.8, // the moon satellite's orbit (rad/s)
        mechanic: 'sunRays',
        params: { rayCount: 4, rayWidth: 0.55, rayActiveGlow: 0.55, shadowArc: 0.5, moonRadius: 13 },
        transition: 'bossHpZero',
        portrait: 'sun', bossTint: '#ffcc44',
        subtitle: "The sun blazes — shelter in the moon's shadow",
        say: {
          intensity: 1,
          enter: ['The SUN takes the sky! Burn in my radiance!'],
          hp: {
            75: ['Feel the daylight sear!'],
            50: ['My corona is ENDLESS!'],
            25: ['The light... flickers?!']
          }
        }
      },
      {
        // Then the moon's turn: the arena goes pitch black and the dark
        // itself burns. The server seeds stars ('star' events, see
        // moonDominant in phases.js); each twinkles as a telegraph, explodes,
        // and leaves a shrinking pool of starlight to shelter in. The moon
        // itself gives off a small glow as the fallback refuge.
        id: 'moon',
        bossHp: 400, bossDamageable: true,
        behavior: 'moonDominant',
        starInterval: 1100, // ms between seeded stars
        mechanic: 'starfield',
        params: { twinkleMs: 1300, lightMs: 4500, lightRadius: 95, starBlastRadius: 55, moonGlowRadius: 110 },
        transition: 'bossHpZero',
        portrait: 'moon', bossTint: '#c9d4ea',
        subtitle: 'Pitch black burns — stay in the starlight',
        say: {
          intensity: 2,
          enter: ['Then darkness. The MOON will swallow you whole.'],
          hp: {
            75: ['The stars are hungry tonight.'],
            50: ['Lost in the dark yet?'],
            25: ['No... the dawn is coming—']
          }
        }
      },
      {
        // Sun and moon converge: the moon disc slides over the sun
        // (broadcast as mech.moonT, see converge in phases.js), totality
        // blinds everyone for a beat, then the corona fires dense rings with
        // a single rotating safe gap.
        id: 'eclipse',
        bossHp: 700, bossDamageable: true,
        behavior: 'converge',
        convergeMs: 2600, // how long the moon takes to slide over the sun
        mechanic: 'eclipse',
        params: { attackRate: 520, numberOfAngles: 18, bulletSpeed: 2.3, gapArc: 1.0, blindMs: 1000 },
        transition: 'bossHpZero',
        portrait: 'eclipse', bossTint: '#ffcc44',
        subtitle: 'Totality',
        say: {
          intensity: 3,
          enter: ['Sun and moon — TOGETHER. Witness the eclipse!'],
          hp: {
            75: ['There is no light left for you!'],
            50: ['THE CORONA CONSUMES ALL!'],
            25: ['the alignment... is breaking—']
          }
        }
      },
      DEFEATED
    ]
  },

  // Slanting rain + telegraphed lightning strikes (see the storm mechanic in
  // public/mechanics.js) instead of the default ring, plus wind that
  // continuously pushes players around (see the wind block in server.js) —
  // the rain's sideways drift follows the same wind vector so the whole sky
  // visibly leans with the gusts. `drops` is the sheltered-phase density; the
  // client thins it out on its own during a blown-away gust since raising an
  // umbrella is what makes this safe to run this dense in the first place.
  storm: {
    id: 'storm', name: 'Bullet Storm',
    phases: [
      {
        id: 'main',
        bossHp: 3500, bossDamageable: true,
        behavior: 'stationary', wind: true,
        mechanic: 'storm', params: STORM_RAIN,
        transition: 'bossHpZero',
        say: {
          enter: ['Let the storm begin.'],
          hp: {
            75: ['Just a drizzle so far.'],
            50: ["Now you'll feel the real storm."],
            25: ['The sky itself trembles...']
          }
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 600, chaseSpeed: 90, aimedShotInterval: 1000, aimedBulletSpeed: 3.6,
        wind: true,
        mechanic: 'storm', params: STORM_RAIN,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['THUNDER ANSWERS ME!', 'You woke the storm, fool!'],
            50: ['I AM THE STORM!', 'NOWHERE TO HIDE NOW!'],
            25: ['t-the storm... is breaking apart—', 'NO! NO!! NOOOO!', '*lightning crackles wildly*']
          }
        }
      },
      DEFEATED
    ]
  },

  blitz: {
    id: 'blitz', name: 'Blitz',
    phases: [
      {
        id: 'main',
        bossHp: 1500, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'ring', params: BLITZ_RING,
        transition: 'bossHpZero',
        say: {
          enter: ['Fast. Furious. Fatal. Try to keep up.'],
          hp: {
            75: ['Too slow!'],
            50: ['Getting warmer, aren’t I?'],
            25: ['Alright — no more playing around.']
          }
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 300, chaseSpeed: 110, aimedShotInterval: 800, aimedBulletSpeed: 4.2,
        mechanic: 'ring', params: BLITZ_RING,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['FULL THROTTLE!', 'Burn faster than you can blink!'],
            50: ["I'M UNSTOPPABLE!!", 'CAN’T. CATCH. ME.'],
            25: ["m-my flame's... flickering—", "I WON'T BURN OUT HERE!", '*the fire roars unevenly*']
          }
        }
      },
      DEFEATED
    ]
  },

  helix: {
    id: 'helix', name: 'The Helix',
    phases: [
      {
        id: 'main',
        bossHp: 2000, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'spiral', params: HELIX_SPIRAL,
        transition: 'bossHpZero',
        say: {
          enter: ['Round and round you’ll go.'],
          hp: {
            75: ['Dizzy yet?'],
            50: ['The spiral tightens.'],
            25: ["You're unraveling me..."]
          }
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 500, chaseSpeed: 80, aimedShotInterval: 1200, aimedBulletSpeed: 3.4,
        mechanic: 'spiral', params: HELIX_SPIRAL,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['THE PATTERN BREAKS FREE!', 'Spin with me — FOREVER!'],
            50: ['I AM THE VORTEX!', 'EVERYTHING FALLS INWARD!'],
            25: ["the spiral's... collapsing—", 'HOLD TOGETHER, HOLD—', '*reality warps and stutters*']
          }
        }
      },
      DEFEATED
    ]
  },

  tide: {
    id: 'tide', name: 'Tidal Warden',
    phases: [
      {
        id: 'main',
        bossHp: 2200, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'wave', params: TIDE_WAVE,
        transition: 'bossHpZero',
        say: {
          enter: ['The tide answers to no one.'],
          hp: {
            75: ['A ripple, nothing more.'],
            50: ['The waters rise against you.'],
            25: ["You've breached the seawall..."]
          }
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 600, chaseSpeed: 75, aimedShotInterval: 1100, aimedBulletSpeed: 3.4,
        mechanic: 'wave', params: TIDE_WAVE,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['THE FLOOD COMES FOR YOU!', 'Drown in my fury!'],
            50: ['I AM THE DEEP ITSELF!', 'THE TIDE NEVER STOPS!'],
            25: ['the waters... are receding—', 'NO! STAY! STAY WITH ME!', '*the tide howls and crashes*']
          }
        }
      },
      DEFEATED
    ]
  },

  rain: {
    id: 'rain', name: 'Acid Rain',
    phases: [
      {
        id: 'main',
        bossHp: 1800, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'rain', params: RAIN_DROPS,
        transition: 'bossHpZero',
        say: {
          enter: ['Hope you brought an umbrella.'],
          hp: {
            75: ['Just the first drops.'],
            50: ['It burns more with every drop, doesn’t it?'],
            25: ['The clouds are thinning...']
          }
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 500, chaseSpeed: 95, aimedShotInterval: 900, aimedBulletSpeed: 3.8,
        mechanic: 'rain', params: RAIN_DROPS,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['A DOWNPOUR OF PAIN!', 'Let it ALL corrode!'],
            50: ['I AM THE STORMCLOUD!', 'NOTHING SURVIVES THE RAIN!'],
            25: ['the clouds... are dissolving—', "I WON'T DRY UP! I WON'T!", '*the acid hisses erratically*']
          }
        }
      },
      DEFEATED
    ]
  },

  bombardment: {
    id: 'bombardment', name: 'Bombardment',
    phases: [
      {
        id: 'main',
        bossHp: 100, bossDamageable: true,
        behavior: 'stationary',
        mechanic: 'bombardment', params: BOMBARDMENT_VOLLEYS,
        transition: 'bossHpZero',
        say: {
          enter: ['Brace yourselves. Impact incoming.'],
          hp: {
            75: ['First volley — barely a scratch.'],
            50: ['Auxiliary silos online - doubling payloads.'],
            25: ['Disable safety protocols.']
          }
        }
      },
      {
        // Launch codes: the boss goes quiet and stops taking damage while
        // every player is dropped into their own maze (see the launchCodes
        // behavior in phases.js) rendered in a dedicated slice of the
        // screen. Walls are lethal on contact, and the whole team has
        // def.timeLimit ms to clear their maze together — running out with
        // anyone still inside kills the whole party, not just the laggards.
        id: 'launchCodes',
        bossDamageable: false,
        behavior: 'launchCodes',
        gridSize: 6, timeLimit: 15000,
        mechanic: 'maze', params: {},
        transition: 'mazeCleared',
        subtitle: 'Launch codes incoming — clear your maze before time runs out',
        say: {
          intensity: 2,
          enter: ['Authenticating launch codes. Navigate the grid or be purged.'],
          timeout: ['Authentication failed. Purging.']
        }
      },
      {
        // No aimedShotInterval: bombardment's own escalating missile volleys
        // already carry the enrage, so the generic single targeted shot every
        // other encounter gets is redundant here (waypointChase skips firing
        // it when this is falsy).
        ...ENRAGE_BASE,
        bossHp: 600, chaseSpeed: 85,
        mechanic: 'bombardment', params: BOMBARDMENT_VOLLEYS,
        say: {
          intensity: 3,
          enter: [ENRAGE_ENTER],
          hp: {
            75: ['FULL BOMBARDMENT — NO SURVIVORS!', "Everything I've got. NOW!"],
            50: ["I WON'T STOP FIRING!!", 'SATURATE THE FIELD!'],
            25: ["m-my arsenal's... failing—", 'ONE MORE VOLLEY! JUST ONE MORE!', 'AHAHAHAHAHAHAH!!!!']
          }
        }
      },
      DEFEATED
    ]
  }
};

// Test speedup: e2e suites (see test/run.js) spend most of their wall-clock
// time waiting for bossDamage/orbDamage reports to whittle down real fight
// HP pools and for the eclipse convergence timer, at the same pace a real
// player would. Scaling those knobs down under FAST_TESTS keeps every phase
// transition/behavior reachable and exercised while cutting that wait to a
// fraction, without maintaining a second, hand-tuned copy of every encounter.
if (process.env.FAST_TESTS === '1') {
  const HP_SCALE = 0.04;
  const TIME_SCALE = 0.15;
  // 'twin' is excluded: it's the only encounter bandwidth.test.js runs, which
  // hammers it with a full 10-player lobby all firing in lockstep. That test
  // needs each phase's *total* pool (bossHp x playerCount) large enough to
  // survive a burst of many players' simultaneous hits landing between two
  // game-loop broadcasts — shrunk far enough, that burst can clear several
  // phases in one synchronous pass before any client ever observes being in
  // them. Every other encounter here only ever runs with 1-2 players (a much
  // smaller worst-case burst), where the aggressive scale is safe.
  for (const encounter of Object.values(ENCOUNTERS)) {
    if (encounter.id === 'twin') continue;
    for (const phase of encounter.phases) {
      if ('bossHp' in phase) phase.bossHp = Math.max(10, Math.round(phase.bossHp * HP_SCALE));
      if ('orbHp' in phase) phase.orbHp = Math.max(10, Math.round(phase.orbHp * HP_SCALE));
      if ('convergeMs' in phase) phase.convergeMs = Math.round(phase.convergeMs * TIME_SCALE);
    }
  }
}

module.exports = { ENCOUNTERS };
