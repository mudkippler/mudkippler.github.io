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

// Shared attack cadence: true (and stamps the timer) once params.attackRate
// ms have passed since this mechanic last fired.
function fireReady(ctx) {
    if (ctx.now - (ctx.state.lastAttack || 0) <= ctx.params.attackRate) return false;
    ctx.state.lastAttack = ctx.now;
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
    }
};
