// Client-side boss mechanic registry. Each phase of an encounter names a
// mechanic (see server/encounters.js), and client.js calls the active one's
// update() every frame while the fight is running. A mechanic owns *spawning*
// boss hazards — the generic per-frame simulation and collision of those
// hazards (bullets, missiles, lightning) stays in client.js, so mechanics
// stay small and hazards behave consistently no matter which mechanic
// spawned them.
//
// update(ctx) receives:
//   now                  performance.now() timestamp
//   state                scratch shared by all mechanics, persisting across
//                        phase transitions (so e.g. ring cadence/rotation
//                        carry from the main fight into the enrage chase);
//                        reset only when the encounter changes or resets
//   params               the active phase's `params` from the encounter def
//   boss, orbs, wind     current entity/wind state from the server
//   mech                 the phase's per-tick broadcast values (ray angle,
//                        moon position, ...) or null — see lobby.mech
//   stars                seeded stars from the server's 'star' events
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
// for ZONE_TICK_MS regardless of which zone the player is standing in.
function zoneTick(ctx, damage, source) {
    if (ctx.now < (ctx.state.nextZoneTick || 0)) return;
    ctx.state.nextZoneTick = ctx.now + ZONE_TICK_MS;
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

// --- Moon phase light geometry (shared with the renderer for the same
// --- reason) ---------------------------------------------------------------

// Radius of a star's light pool right now: full at the explosion, shrinking
// to nothing over params.lightMs. 0 while still twinkling or after fading.
export function starLightRadius(star, now, params) {
    const lightAge = now - star.spawn - params.twinkleMs;
    if (lightAge < 0 || lightAge > params.lightMs) return 0;
    return params.lightRadius * (1 - lightAge / params.lightMs);
}

// Pitch black = outside every star's light pool and beyond the moon's own
// glow around the boss.
export function isInPitchDark(x, y, boss, stars, now, params) {
    if (Math.hypot(x - boss.x, y - boss.y) < params.moonGlowRadius) return false;
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

    // Twin's moon phase: the server seeds stars (ctx.stars, stamped with
    // their local arrival time); each twinkles for twinkleMs as a telegraph,
    // explodes once (an instant hit like lightning), then leaves a shrinking
    // light pool. Standing in pitch black — outside every pool and the
    // moon's own glow — burns as a damage-over-time zone.
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

            if (ctx.alive && ctx.myPos && isInPitchDark(ctx.myPos.x, ctx.myPos.y, ctx.boss, ctx.stars, ctx.now, p)) {
                zoneTick(ctx, DARK_DAMAGE, 'dark');
            }
        }
    },

    // Twin's eclipse: quiet while the moon slides over the sun (mech.moonT
    // ramping 0..1), a blinding flash at totality, then dense corona rings
    // with a single rotating safe gap once sight starts returning. The blind
    // timestamp lives in state so the renderer can draw the same flash.
    eclipse: {
        update(ctx) {
            const t = ctx.mech ? ctx.mech.moonT : 0;
            if (t < 1) return; // still converging — the calm before totality

            if (!ctx.state.blindStart) ctx.state.blindStart = ctx.now;
            if (ctx.now < ctx.state.blindStart + ctx.params.blindMs * 0.5) return; // firing starts as sight returns

            if (!fireReady(ctx)) return;
            const gap = ctx.state.gapAngle || 0;
            for (let i = 0; i < ctx.params.numberOfAngles; i++) {
                const ang = i * (Math.PI * 2 / ctx.params.numberOfAngles);
                if (Math.abs(angleDiff(ang, gap)) < ctx.params.gapArc / 2) continue; // the safe gap
                ctx.bossBullets.push({
                    x: ctx.boss.x,
                    y: ctx.boss.y,
                    dx: Math.cos(ang) * ctx.params.bulletSpeed,
                    dy: Math.sin(ang) * ctx.params.bulletSpeed,
                    type: 8, // corona ring — see BULLET_STYLES in renderer.js
                    size: 6
                });
            }
            ctx.state.gapAngle = gap + 0.4;
        }
    }
};
