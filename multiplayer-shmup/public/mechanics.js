// Client-side boss mechanic registry. Each phase of an encounter names one
// mechanic — or several at once via `mechanics` (see server/encounters.js and
// activeMechanics below) — and client.js calls each active one's update()
// every frame while the fight is running. A mechanic owns *spawning* boss
// hazards — the generic per-frame simulation and collision of those hazards
// (bullets, missiles, lightning) stays in client.js, so mechanics stay small
// and hazards behave consistently no matter which mechanic spawned them.
//
// update(ctx) receives:
//   now                  performance.now() timestamp
//   state                this mechanic's own scratch (keyed by mechanic name
//                        in client.js so simultaneous mechanics don't trample
//                        each other's timers), persisting across phase
//                        transitions (so e.g. ring cadence/rotation carry
//                        from the main fight into the enrage chase); reset
//                        only when the encounter changes or resets
//   shared               scratch shared across *all* mechanics with the same
//                        lifetime — cross-mechanic concerns like the zone
//                        damage tick immunity window live here
//   params               this mechanic's `params` from the encounter def
//   boss, orbs, wind     current entity/wind state from the server
//   mech                 the phase's per-tick broadcast values (ray angle,
//                        moon position, ...) or null — see lobby.mech
//   stars                seeded stars from the server's 'star' events
//   flares               seeded solar flares from the server's 'flare' events
//   myPos, alive         the local player, for zone damage checks
//   send, addDamagePopup damage reporting hooks
//   bossBullets          moving projectiles (simulated per-frame in client.js)
//   bossMissiles         bombardment's timed ground hazards
//   bossLightning        storm's timed strike hazards

import {
    circularAttack,
    bigRedBallAttack,
    spiralAttack,
    waveAttack,
    rainAttack,
    stormRainAttack,
    lightningAttack,
    bombardmentAttack
} from './attacks.js';

// Local mirrors of the server's PLAYER_DAMAGE_BY_SOURCE amounts — used for
// the damage popups only; the server stays authoritative for actual health.
export const STAR_DAMAGE = 25;
export const RAY_DAMAGE = 12;
export const DARK_DAMAGE = 1;
export const FLARE_DAMAGE = 15;

// A phase's active mechanics, normalized to a list: `mechanics` lets a phase
// run several at once (each with its own params); the single
// `mechanic`/`params` pair stays the common case.
export function activeMechanics(def) {
    if (def.mechanics) return def.mechanics;
    return [{ mechanic: def.mechanic, params: def.params }];
}

// Zones deal damage-over-time: one report per this many ms of exposure,
// rather than per frame — the counterpart of the server's fixed per-source
// amounts above.
const ZONE_TICK_MS = 500;

// Shared attack cadence: true (and stamps the timer) once params.attackRate
// ms have passed since this mechanic last fired.
function fireReady(ctx) {
    if (ctx.now - (ctx.state.lastAttack || 0) <= ctx.params.attackRate) return false;
    ctx.state.lastAttack = ctx.now;
    return true;
}

// One zone damage tick: popup + report, then immune to further zone ticks
// for ZONE_TICK_MS regardless of which zone the player is standing in. The
// immunity window lives in the cross-mechanic shared scratch so overlapping
// zones from two simultaneous mechanics can't double-tick.
function zoneTick(ctx, damage, source) {
    const shared = ctx.shared || ctx.state;
    if (ctx.now < (shared.nextZoneTick || 0)) return;
    shared.nextZoneTick = ctx.now + ZONE_TICK_MS;
    ctx.addDamagePopup(ctx.myPos.x, ctx.myPos.y, -damage, 'red');
    ctx.send({ type: 'playerDamage', source });
}

// Smallest signed difference between two angles, in [-PI, PI].
export function angleDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

// --- Sun phase zone geometry (shared with the renderer so what burns is
// --- exactly what's drawn) -------------------------------------------------

// Whether a point sits inside one of the sun's ray wedges (ignoring glow —
// the caller decides whether the rays are currently active or telegraphing).
export function isInSunRay(x, y, boss, mech, params) {
    const ang = Math.atan2(y - boss.y, x - boss.x);
    for (let i = 0; i < params.rayCount; i++) {
        const center = mech.ray + i * (Math.PI * 2 / params.rayCount);
        if (Math.abs(angleDiff(ang, center)) < params.rayWidth / 2) return true;
    }
    return false;
}

// Whether a point sits in the moon's shadow: within the shadow's arc as seen
// from the sun, and at least as far out as the moon (the shadow is cast
// *away* from the sun, starting slightly before the moon to be forgiving).
export function isInMoonShadow(x, y, boss, mech, params) {
    if (!mech.moon) return false;
    const moonAng = Math.atan2(mech.moon.y - boss.y, mech.moon.x - boss.x);
    const moonDist = Math.hypot(mech.moon.x - boss.x, mech.moon.y - boss.y);
    const ang = Math.atan2(y - boss.y, x - boss.x);
    const dist = Math.hypot(x - boss.x, y - boss.y);
    return Math.abs(angleDiff(ang, moonAng)) < params.shadowArc / 2 && dist > moonDist - 20;
}

// --- Solar flare geometry (shared with the renderer for the same reason) ---

// Where a flare's wedge points right now: it sweeps from its seeded angle at
// its own spin rate — noticeably faster than the main rays.
export function flareAngle(flare, now) {
    return flare.ang + flare.spin * ((now - flare.spawn) / 1000);
}

// Whether a point sits inside a flare's wedge — within its angular width AND
// within its reach from the boss (flares are close-range sparks, not
// arena-spanning rays). Deliberately no moon-shadow check anywhere near
// this: a flare burns through the safe zone.
export function isInSolarFlare(x, y, boss, flare, now) {
    if (Math.hypot(x - boss.x, y - boss.y) > flare.len) return false;
    const ang = Math.atan2(y - boss.y, x - boss.x);
    return Math.abs(angleDiff(ang, flareAngle(flare, now))) < flare.w / 2;
}

// --- Moon phase light geometry (shared with the renderer for the same
// --- reason) ---------------------------------------------------------------

// Radius of a star's light pool right now: full at the explosion, shrinking
// to nothing over params.lightMs. 0 while still twinkling or after fading.
export function starLightRadius(star, now, params) {
    const lightAge = now - star.spawn - params.twinkleMs;
    if (lightAge < 0 || lightAge > params.lightMs) return 0;
    return params.lightRadius * (1 - lightAge / params.lightMs);
}

// Pitch black = outside every star's light pool. The starlight is the only
// refuge — the moon itself gives no safe glow.
export function isInPitchDark(x, y, stars, now, params) {
    for (const star of stars) {
        const r = starLightRadius(star, now, params);
        if (r > 0 && Math.hypot(x - star.x, y - star.y) < r) return false;
    }
    return true;
}

export const MECHANICS = {
    // Terminal phases: the boss stops shooting immediately, sweeping anything
    // still in flight.
    none: {
        update(ctx) {
            ctx.bossBullets.length = 0;
            ctx.bossMissiles.length = 0;
            ctx.bossLightning.length = 0;
        }
    },

    // The classic rotating ring + occasional big red ball.
    ring: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            circularAttack(ctx.boss, ctx.bossBullets, ctx.state.angleOffset || 0, ctx.params.numberOfAngles, ctx.params.bulletSpeed);
            ctx.state.angleOffset = (ctx.state.angleOffset || 0) + 0.1;
            if (Math.random() < (ctx.params.bigRedChance || 0)) {
                bigRedBallAttack(ctx.boss, ctx.bossBullets);
            }
        }
    },

    // Twin orb phase: each living orb fires the ring pattern instead of the
    // (invulnerable) main body.
    orbRings: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            for (const orb of ctx.orbs) {
                if (orb.hp > 0) circularAttack(orb, ctx.bossBullets, ctx.state.angleOffset || 0, ctx.params.numberOfAngles, ctx.params.bulletSpeed);
            }
            ctx.state.angleOffset = (ctx.state.angleOffset || 0) + 0.15;
        }
    },

    spiral: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            spiralAttack(ctx.boss, ctx.bossBullets, ctx.state.angleOffset || 0, ctx.params.arms, ctx.params.bulletSpeed);
            ctx.state.angleOffset = (ctx.state.angleOffset || 0) + 0.23;
        }
    },

    wave: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            waveAttack(ctx.boss, ctx.bossBullets, ctx.now, ctx.params.bulletSpeed, ctx.params.fanCount);
        }
    },

    rain: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            rainAttack(ctx.bossBullets, ctx.params.bulletSpeed, ctx.params.drops);
        }
    },

    // Wind-driven rain plus lightning strikes on their own cadence. The rain
    // is dense while the umbrella can shelter you from it and fades to a
    // drizzle while a gust has it blown away (wind.umbrella === false), so
    // being briefly exposed doesn't feel unfair.
    storm: {
        update(ctx) {
            if (fireReady(ctx)) {
                const sheltered = ctx.wind.umbrella !== false;
                const drops = sheltered ? ctx.params.drops : Math.max(2, Math.round(ctx.params.drops / 3));
                const speed = sheltered ? ctx.params.bulletSpeed : ctx.params.bulletSpeed * 0.6;
                stormRainAttack(ctx.bossBullets, speed, drops, ctx.wind);
            }

            // Lightning runs independent of the rain rate, randomized a
            // little each time so bolts don't fall into a predictable rhythm.
            if (ctx.now - (ctx.state.lastLightning || 0) > (ctx.state.lightningInterval || 1800)) {
                ctx.state.lastLightning = ctx.now;
                ctx.state.lightningInterval = 1400 + Math.random() * 1400;
                lightningAttack(ctx.bossLightning, ctx.now);
            }
        }
    },

    // Volleys of telegraphed missile lines. The "low health" escalation
    // (extra missiles per line / extra simultaneous lines) is a ratchet —
    // the highest level earned so far — rather than a pure function of the
    // current hp fraction: the enrage phase refills the boss's HP into a
    // smaller pool, and bonuses already earned should persist through that
    // refill and keep climbing, not reset back to "full health" difficulty.
    // (state survives phase transitions and only resets with the encounter,
    // which is exactly the lifetime the ratchet needs.)
    bombardment: {
        update(ctx) {
            if (!fireReady(ctx)) return;
            const hpFraction = ctx.boss.hp / (ctx.boss.maxHp || 1);
            ctx.state.missileBonus = Math.max(ctx.state.missileBonus || 0, Math.floor((1 - hpFraction) / 0.15));
            ctx.state.lineBonus = Math.max(ctx.state.lineBonus || 0, Math.floor((1 - hpFraction) / 0.10));
            bombardmentAttack(ctx.bossMissiles, ctx.now, 1 + ctx.state.missileBonus, 1 + ctx.state.lineBonus);
        }
    },

    // Launch codes: no client-spawned hazards — the maze layout and its
    // wall/exit checks are entirely server-driven (see launchCodes in
    // server/phases.js and the 'maze' handling in renderer.js), since the
    // maze geometry has to be identical for every client's collision *and*
    // render. Sweeps anything left over from the phase before it, same as
    // the terminal 'none' mechanic.
    maze: {
        update(ctx) {
            ctx.bossBullets.length = 0;
            ctx.bossMissiles.length = 0;
            ctx.bossLightning.length = 0;
        }
    },

    // Twin's sun phase: no projectiles at all — the threat is standing in an
    // active ray outside the moon's shadow. Geometry comes entirely from the
    // server's per-tick mech broadcast (ray angle, glow, moon position) so
    // every client agrees on where it burns; the renderer draws the same
    // wedges from the same values.
    sunRays: {
        update(ctx) {
            const mech = ctx.mech;
            if (!mech || !ctx.alive || !ctx.myPos) return;
            if (mech.glow < ctx.params.rayActiveGlow) return; // rays are only telegraphing
            if (isInSunRay(ctx.myPos.x, ctx.myPos.y, ctx.boss, mech, ctx.params)
                && !isInMoonShadow(ctx.myPos.x, ctx.myPos.y, ctx.boss, mech, ctx.params)) {
                zoneTick(ctx, RAY_DAMAGE, 'ray');
            }
        }
    },

    // Twin's sun phase, second simultaneous mechanic: solar flares. The
    // server seeds each one (ctx.flares, stamped with its local arrival time
    // like stars) with a random width and spin; it telegraphs for
    // telegraphMs, then burns for activeMs — and unlike the main rays, the
    // moon's shadow does NOT shelter you from it.
    solarFlares: {
        update(ctx) {
            const p = ctx.params;
            for (let i = ctx.flares.length - 1; i >= 0; i--) {
                const flare = ctx.flares[i];
                const age = ctx.now - flare.spawn;
                if (age > p.telegraphMs + p.activeMs) {
                    ctx.flares.splice(i, 1);
                    continue;
                }
                if (age < p.telegraphMs) continue; // still telegraphing
                if (ctx.alive && ctx.myPos && isInSolarFlare(ctx.myPos.x, ctx.myPos.y, ctx.boss, flare, ctx.now)) {
                    zoneTick(ctx, FLARE_DAMAGE, 'flare');
                }
            }
        }
    },

    // Twin's moon phase: the server seeds stars (ctx.stars, stamped with
    // their local arrival time); each twinkles for twinkleMs as a telegraph,
    // explodes once (an instant hit like lightning), then leaves a shrinking
    // light pool. Standing in pitch black — outside every pool — burns as a
    // damage-over-time zone; the moon itself offers no refuge.
    starfield: {
        update(ctx) {
            const p = ctx.params;
            for (let i = ctx.stars.length - 1; i >= 0; i--) {
                const star = ctx.stars[i];
                const age = ctx.now - star.spawn;

                if (!star.exploded && age >= p.twinkleMs) {
                    star.exploded = true;
                    if (ctx.alive && ctx.myPos && Math.hypot(ctx.myPos.x - star.x, ctx.myPos.y - star.y) < p.starBlastRadius) {
                        ctx.addDamagePopup(star.x, star.y, -STAR_DAMAGE, 'red');
                        ctx.send({ type: 'playerDamage', source: 'star' });
                    }
                }

                if (age > p.twinkleMs + p.lightMs) ctx.stars.splice(i, 1);
            }

            if (ctx.alive && ctx.myPos && isInPitchDark(ctx.myPos.x, ctx.myPos.y, ctx.stars, ctx.now, p)) {
                zoneTick(ctx, DARK_DAMAGE, 'dark');
            }
        }
    },

    // Twin's eclipse: quiet while the moon slides over the sun (mech.moonT
    // ramping 0..1), then totality — a blinding flash that recurs every
    // blindIntervalMs, and between flashes the corona fires tightly packed
    // bullet arcs with a single rotating safe gap. The blind timestamp lives
    // in state so the renderer can draw the same flash.
    eclipse: {
        update(ctx) {
            const t = ctx.mech ? ctx.mech.moonT : 0;
            if (t < 1) return; // still converging — the calm before totality

            if (!ctx.state.blindStart) ctx.state.blindStart = ctx.now;
            // Totality flashes again periodically, not just once on arrival.
            if (ctx.params.blindIntervalMs && ctx.now - ctx.state.blindStart > ctx.params.blindIntervalMs) {
                ctx.state.blindStart = ctx.now;
            }
            if (ctx.now < ctx.state.blindStart + ctx.params.blindMs * 0.5) return; // firing pauses while blinded

            if (!fireReady(ctx)) return;
            // Each volley: arcCount evenly spaced arcs, each a tight fan of
            // arcBullets bullets spanning arcSpan radians — they fly outward
            // as dense curved bands. One arc slot rotates as the safe gap.
            const gap = ctx.state.gapAngle || 0;
            const arcStep = Math.PI * 2 / ctx.params.arcCount;
            const spacing = ctx.params.arcSpan / Math.max(1, ctx.params.arcBullets - 1);
            for (let i = 0; i < ctx.params.arcCount; i++) {
                const center = i * arcStep;
                if (Math.abs(angleDiff(center, gap)) < ctx.params.gapArc / 2) continue; // the safe gap
                for (let j = 0; j < ctx.params.arcBullets; j++) {
                    const ang = center + (j - (ctx.params.arcBullets - 1) / 2) * spacing;
                    ctx.bossBullets.push({
                        x: ctx.boss.x,
                        y: ctx.boss.y,
                        dx: Math.cos(ang) * ctx.params.bulletSpeed,
                        dy: Math.sin(ang) * ctx.params.bulletSpeed,
                        type: 8, // corona arc — see BULLET_STYLES in renderer.js
                        size: 6
                    });
                }
            }
            ctx.state.gapAngle = gap + 0.4;
        }
    }
};
