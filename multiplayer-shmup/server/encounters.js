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
        bossHp: 2500, bossDamageable: true,
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
        behavior: 'twinOrbs', orbHp: 300, orbKillWindow: 3000,
        mechanic: 'orbRings', params: { attackRate: 200, numberOfAngles: 4, bulletSpeed: 1 },
        transition: 'orbsDead',
        subtitle: 'Destroy the twin orbs — together',
        say: {
          enter: ["i'm just getting started.."],
          orbsRevive: ['you must strike them down together!']
        }
      },
      {
        ...ENRAGE_BASE,
        bossHp: 800, chaseSpeed: 70, aimedShotInterval: 1400, aimedBulletSpeed: 3.2,
        mechanic: 'ring', params: TWIN_RING,
        say: {
          intensity: 3,
          enter: ['impossible... you struck as one... but I am not finished!'],
          hp: {
            75: ['I said ENOUGH!', 'Both blades. No mercy now.'],
            50: ['I WILL NOT FALL TO THIS!', 'Stand still and DIE!'],
            25: ["This... isn't... POSSIBLE—", 'I REFUSE! I REFUSE!!', '*the blades scream with him*']
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
        bossHp: 5000, bossDamageable: true,
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

module.exports = { ENCOUNTERS };
