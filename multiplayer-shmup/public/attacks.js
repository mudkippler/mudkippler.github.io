// Boss attack patterns, simulated locally on each client.
// These are cosmetic/local only — the server does not know about boss bullets,
// it only tracks boss HP. Each client reports damage it lands on/takes from the boss.

let bulletIdCounter = 0;

export function circularAttack(boss, bossBullets, angleOffset, numberOfAngles = 4, bulletVelocity = 1) {
    const angleIncrement = Math.PI * 2 / numberOfAngles;
    for (let i = 0; i < numberOfAngles; i++) {
        const angle = i * angleIncrement;
        bossBullets.push({
            id: bulletIdCounter++,
            x: boss.x,
            y: boss.y,
            dx: Math.cos(angle + angleOffset) * bulletVelocity,
            dy: Math.sin(angle + angleOffset) * bulletVelocity,
            type: 1, // 1 for circular
            size: 6
        });
    }
}

export function bigRedBallAttack(boss, bossBullets) {
    bossBullets.push({
        id: bulletIdCounter++,
        x: boss.x,
        y: boss.y,
        dx: (Math.random() - 0.5) * 10,
        dy: (Math.random() - 0.5) * 10,
        type: 2, // 2 for bigRedBall
        size: 20
    });
}

// Multi-arm spiral: one bullet per arm each volley, with the caller advancing
// angleOffset between volleys so the arms sweep into continuous spiral curls.
export function spiralAttack(boss, bossBullets, angleOffset, arms = 3, bulletVelocity = 1.6) {
    for (let i = 0; i < arms; i++) {
        const angle = angleOffset + i * (Math.PI * 2 / arms);
        bossBullets.push({
            id: bulletIdCounter++,
            x: boss.x,
            y: boss.y,
            dx: Math.cos(angle) * bulletVelocity,
            dy: Math.sin(angle) * bulletVelocity,
            type: 4, // 4 for spiral
            size: 5
        });
    }
}

// Downward fan of bullets whose center direction sweeps side to side over
// time like a hose, forcing players to keep strafing out from under it.
export function waveAttack(boss, bossBullets, now, bulletVelocity = 1.8, fanCount = 5) {
    const sweep = Math.sin(now / 600) * (Math.PI / 3); // center sweeps ±60° around straight down
    const spread = Math.PI / 10; // gap between adjacent bullets in the fan
    for (let i = 0; i < fanCount; i++) {
        const angle = Math.PI / 2 + sweep + (i - (fanCount - 1) / 2) * spread;
        bossBullets.push({
            id: bulletIdCounter++,
            x: boss.x,
            y: boss.y,
            dx: Math.cos(angle) * bulletVelocity,
            dy: Math.sin(angle) * bulletVelocity,
            type: 5, // 5 for wave
            size: 5
        });
    }
}

// Droplets falling from random points along the top edge with a little
// sideways drift — dodging is about reading the whole sky, not the boss.
export function rainAttack(bossBullets, bulletVelocity = 2.2, drops = 3) {
    for (let i = 0; i < drops; i++) {
        bossBullets.push({
            id: bulletIdCounter++,
            x: Math.random() * 800,
            y: 1, // just inside the top edge so the offscreen cull doesn't eat it
            dx: (Math.random() - 0.5) * 0.8,
            dy: bulletVelocity * (0.7 + Math.random() * 0.6),
            type: 6, // 6 for rain
            size: 5
        });
    }
}

// One or more volleys of missiles fired offscreen that each land in a line,
// one after another, each telegraphing its landing spot before it impacts.
// Unlike the other attacks these aren't moving projectiles — they're timed
// hazards, so the caller (client.js) drives them by wall-clock time rather
// than per-frame dx/dy. The caller resolves missileCount/lineCount from its
// own escalation state (see bombardmentMissileBonus/LineBonus in client.js) —
// this function just fires what it's told to.
export const MISSILE_BLAST_RADIUS = 45; // px, final ring size — also the telegraph's footprint
export const MISSILE_EXPLOSION_DURATION = 300; // ms the ring stays out (and stays a hitbox) after impact
export const MISSILE_DAMAGE = 35; // matches the server's MISSILE_DAMAGE — used for the local damage popup only

const LAUNCH_TO_IMPACT = 900; // ms a missile is airborne/offscreen before landing
const STAGGER = 220; // ms between each missile's impact within its line

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

// A single line: missiles centered on a random point, spaced out along a
// random angle (not always horizontal) and clamped to stay in-bounds.
function fireLine(missiles, now, missileCount, arena) {
    const spacing = 70; // px between impact points along the line
    const angle = (Math.random() - 0.5) * Math.PI * 0.8; // roughly ±72° off horizontal
    const cx = arena.xMin + Math.random() * (arena.xMax - arena.xMin);
    const cy = arena.yMin + Math.random() * (arena.yMax - arena.yMin);

    for (let i = 0; i < missileCount; i++) {
        const offset = (i - (missileCount - 1) / 2) * spacing;
        const x = clamp(cx + Math.cos(angle) * offset, arena.xMin, arena.xMax);
        const y = clamp(cy + Math.sin(angle) * offset, arena.yMin, arena.yMax);
        missiles.push({
            id: bulletIdCounter++,
            x,
            y,
            radius: MISSILE_BLAST_RADIUS,
            spawnTime: now,
            impactTime: now + LAUNCH_TO_IMPACT + i * STAGGER,
            exploded: false,
            explodedAt: null,
            hit: false
        });
    }
}

export function bombardmentAttack(missiles, now, missileCount, lineCount, arena = { xMin: 80, xMax: 720, yMin: 380, yMax: 560 }) {
    for (let line = 0; line < lineCount; line++) {
        fireLine(missiles, now, missileCount, arena);
    }
}
