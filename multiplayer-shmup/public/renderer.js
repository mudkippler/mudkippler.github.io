import { MISSILE_EXPLOSION_DURATION, LIGHTNING_WARNING_MS, LIGHTNING_STRIKE_MS, LIGHTNING_WIDTH, STORM_UMBRELLA_X, STORM_UMBRELLA_Y, STORM_UMBRELLA_HALF_WIDTH } from './attacks.js';
import { starLightRadius, flareAngle } from './mechanics.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// Boss body sprites: drop img/<encounterId>[_<state>]_sprite.png into public/img
// (same state names as the portrait convention in bossportrait.js — 'sun',
// 'moon', 'eclipse', ...) and it's drawn in place of the plain circle body.
// A missing file just falls back to the circle instead of a broken image.
const bossSpriteCache = {};
function bossSpriteFor(encounterId, state) {
    if (!encounterId) return null;
    const src = `img/${encounterId}${state && state !== 'base' ? `_${state}` : ''}_sprite.png`;
    let entry = bossSpriteCache[src];
    if (!entry) {
        const img = new Image();
        entry = { img, ready: false, failed: false };
        img.onload = () => { entry.ready = true; };
        img.onerror = () => { entry.failed = true; };
        img.src = src;
        bossSpriteCache[src] = entry;
    }
    return entry.ready ? entry.img : null;
}

// Small tombstone icon marking a resurrectable (currently-dead) player.
function drawGravestone(x, y, color) {
    const w = 16, h = 18;
    ctx.fillStyle = '#999';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y + h / 2);
    ctx.lineTo(x - w / 2, y - h / 2 + 5);
    ctx.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + 5, y - h / 2);
    ctx.lineTo(x + w / 2 - 5, y - h / 2);
    ctx.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + 5);
    ctx.lineTo(x + w / 2, y + h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Engraved cross
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - h / 2 + 6);
    ctx.lineTo(x, y + 3);
    ctx.moveTo(x - 3, y - 3);
    ctx.lineTo(x + 3, y - 3);
    ctx.stroke();

    // Color accent identifying whose body this is
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y + h / 2 - 3, w, 3);
}

// A small missile sprite: nose cone + flame, rotated to face its direction
// of travel (angle is a standard atan2(dy, dx) — the shape is drawn nose-up
// by default, so it needs a +90° correction to line up with that convention).
function drawRocket(x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(4, 4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff8844';
    ctx.beginPath();
    ctx.moveTo(-3, 4);
    ctx.lineTo(0, 13);
    ctx.lineTo(3, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

const ROCKET_FLIGHT_MS = 300; // ms spent visibly ascending from the boss / descending to the ground
const OFFSCREEN_Y = -40; // where the rocket "disappears" to between ascent and descent

// Storm's umbrella: a fixed structure on the field, not a per-player ability
// — everyone sees the same one, standing at the same spot. Fades in/out
// smoothly across a gust's arrival/departure rather than popping, and the
// pale band beneath it traces out the actual "safe to stand here" footprint
// (matches isBlockedByStormUmbrella's hitbox in attacks.js) so the shelter
// zone reads clearly at a glance instead of players having to guess its edges.
let umbrellaAlpha = 0;

function drawStormUmbrella(active, dt) {
    umbrellaAlpha += ((active ? 1 : 0) - umbrellaAlpha) * Math.min(1, dt * 6);
    if (umbrellaAlpha < 0.02) return;

    ctx.save();
    ctx.globalAlpha = umbrellaAlpha;

    // Shelter footprint on the ground below the canopy.
    ctx.fillStyle = 'rgba(120, 180, 255, 0.07)';
    ctx.fillRect(
        STORM_UMBRELLA_X - STORM_UMBRELLA_HALF_WIDTH, STORM_UMBRELLA_Y,
        STORM_UMBRELLA_HALF_WIDTH * 2, 600 - STORM_UMBRELLA_Y
    );

    ctx.translate(STORM_UMBRELLA_X, STORM_UMBRELLA_Y);

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 40);
    ctx.stroke();

    ctx.fillStyle = '#4da6ff';
    ctx.strokeStyle = '#0a0a0d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, STORM_UMBRELLA_HALF_WIDTH, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Ribs so it reads as a canopy, not a blob.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1;
    for (const frac of [-0.85, -0.4, 0, 0.4, 0.85]) {
        ctx.beginPath();
        ctx.moveTo(frac * STORM_UMBRELLA_HALF_WIDTH, 0);
        ctx.lineTo(frac * STORM_UMBRELLA_HALF_WIDTH * 0.25, -STORM_UMBRELLA_HALF_WIDTH * 0.9);
        ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
}

let shakeEndTime = 0;
const SHAKE_DURATION = 200; // ms
const SHAKE_MAGNITUDE = 6; // px

// --- Twin's sun/moon/eclipse mechanic visuals ------------------------------
// All geometry comes from the same server-broadcast mech values and params
// the damage checks in mechanics.js use, so what's drawn is exactly what
// burns. Split into an under layer (ground zones, drawn beneath entities)
// and an over layer (darkness/flashes that dim or cover the scene).

const RAY_LENGTH = 950; // px, past every corner of the 800x600 arena

// Sun phase (under layer): the rotating ray wedges, the moon satellite, and
// its shadow — a dark annular sector cast away from the sun.
function drawSunPhase(view, entry, boss) {
    const { mech } = view;
    const params = entry.params;
    if (!mech) return;

    const active = mech.glow >= params.rayActiveGlow;
    // Telegraphing rays are faint; active ones glow with the pulse.
    ctx.globalAlpha = active ? 0.18 + 0.22 * mech.glow : 0.04 + 0.12 * mech.glow;
    ctx.fillStyle = active ? '#ffb43c' : '#ffe9a8';
    for (let i = 0; i < params.rayCount; i++) {
        const center = mech.ray + i * (Math.PI * 2 / params.rayCount);
        ctx.beginPath();
        ctx.moveTo(boss.x, boss.y);
        ctx.arc(boss.x, boss.y, RAY_LENGTH, center - params.rayWidth / 2, center + params.rayWidth / 2);
        ctx.closePath();
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Glowing bloom along the borders of active rays, so the exact edge of
    // "standing here burns" reads at a glance.
    if (active) {
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.4 * mech.glow;
        ctx.strokeStyle = '#ffdf80';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#ffb43c';
        ctx.shadowBlur = 14;
        for (let i = 0; i < params.rayCount; i++) {
            const center = mech.ray + i * (Math.PI * 2 / params.rayCount);
            for (const side of [-1, 1]) {
                const edge = center + side * params.rayWidth / 2;
                ctx.beginPath();
                ctx.moveTo(boss.x, boss.y);
                ctx.lineTo(boss.x + Math.cos(edge) * RAY_LENGTH, boss.y + Math.sin(edge) * RAY_LENGTH);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // Corona ring so the boss reads as the sun itself.
    ctx.globalAlpha = 0.35 + 0.4 * mech.glow;
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, boss.radius + 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (mech.moon) {
        const moonAng = Math.atan2(mech.moon.y - boss.y, mech.moon.x - boss.x);
        const moonDist = Math.hypot(mech.moon.x - boss.x, mech.moon.y - boss.y);

        // The shadow: starts slightly before the moon (matching the damage
        // check's forgiveness) and runs outward.
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#0d1226';
        ctx.beginPath();
        ctx.arc(boss.x, boss.y, RAY_LENGTH, moonAng - params.shadowArc / 2, moonAng + params.shadowArc / 2);
        ctx.arc(boss.x, boss.y, Math.max(0, moonDist - 20), moonAng + params.shadowArc / 2, moonAng - params.shadowArc / 2, true);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        // The moon satellite itself.
        ctx.fillStyle = '#cdd6e8';
        ctx.strokeStyle = '#8a94ad';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mech.moon.x, mech.moon.y, params.moonRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

// Solar flares (under layer, drawn after the sun's rays and the moon's
// shadow so it's visibly true that the shadow does NOT shelter from them):
// close-range sparks off the sun's surface, not arena-spanning rays. Each
// server-seeded flare telegraphs as a dashed wedge outline filling in as
// ignition nears, then burns as a flowing tongue of flame — hottest at the
// boss, wavering at its tip — out to its rolled reach (flare.len).
function drawSolarFlares(view, entry, boss) {
    const now = performance.now();
    const p = entry.params;
    for (const flare of view.flares) {
        const age = now - flare.spawn;
        if (age > p.telegraphMs + p.activeMs) continue;
        const center = flareAngle(flare, now);
        const a0 = center - flare.w / 2;
        const a1 = center + flare.w / 2;

        if (age < p.telegraphMs) {
            // Telegraph: the danger wedge outlined in dashes and faintly
            // filled, both intensifying as the flare is about to ignite.
            const dangerFrac = age / p.telegraphMs;
            ctx.globalAlpha = 0.06 + 0.1 * dangerFrac;
            ctx.fillStyle = '#ff7733';
            ctx.beginPath();
            ctx.moveTo(boss.x, boss.y);
            ctx.arc(boss.x, boss.y, flare.len, a0, a1);
            ctx.closePath();
            ctx.fill();

            ctx.globalAlpha = 0.35 + 0.4 * dangerFrac;
            ctx.strokeStyle = '#ff7733';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 6]);
            ctx.beginPath();
            ctx.moveTo(boss.x, boss.y);
            ctx.arc(boss.x, boss.y, flare.len, a0, a1);
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
        } else {
            // Burning: a flame tongue — its sides bulge slightly outside the
            // danger wedge (visual reads a touch bigger than the hitbox,
            // never smaller) and converge on a tip that sways and stretches,
            // flickering the whole time and dying down at the very end.
            const burnLeft = 1 - (age - p.telegraphMs) / p.activeMs;
            const flicker = 0.8 + 0.2 * Math.sin(now / 45 + flare.ang * 7);
            const tipAng = center + flare.w * 0.2 * Math.sin(now / 150 + flare.ang * 3);
            const tipR = flare.len * (0.98 + 0.09 * Math.sin(now / 110 + flare.ang * 5));
            const bulge = flare.w * 0.25;

            const g = ctx.createRadialGradient(boss.x, boss.y, boss.radius * 0.4, boss.x, boss.y, flare.len);
            g.addColorStop(0, 'rgba(255, 224, 130, 0.95)');
            g.addColorStop(0.45, 'rgba(255, 120, 40, 0.6)');
            g.addColorStop(1, 'rgba(255, 60, 20, 0.08)');

            ctx.save();
            ctx.globalAlpha = (0.45 + 0.4 * Math.min(1, burnLeft * 3)) * flicker;
            ctx.fillStyle = g;
            ctx.shadowColor = '#ff5522';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.moveTo(boss.x + Math.cos(a0) * 8, boss.y + Math.sin(a0) * 8);
            ctx.quadraticCurveTo(
                boss.x + Math.cos(a0 - bulge) * flare.len * 0.6, boss.y + Math.sin(a0 - bulge) * flare.len * 0.6,
                boss.x + Math.cos(tipAng) * tipR, boss.y + Math.sin(tipAng) * tipR
            );
            ctx.quadraticCurveTo(
                boss.x + Math.cos(a1 + bulge) * flare.len * 0.6, boss.y + Math.sin(a1 + bulge) * flare.len * 0.6,
                boss.x + Math.cos(a1) * 8, boss.y + Math.sin(a1) * 8
            );
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }
    ctx.globalAlpha = 1;
}

// Moon phase (over layer): pitch-black darkness with even-odd holes punched
// out for every light source, then the stars' twinkles, explosions, and
// light-pool rims drawn on top so they stay visible in the dark.
function drawMoonPhase(view, entry, boss) {
    const { stars } = view;
    const params = entry.params;
    const now = performance.now();

    // The darkness, with holes punched only where starlight pools — the
    // moon/boss itself casts no safe glow.
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    for (const star of stars) {
        const r = starLightRadius(star, now, params);
        if (r > 0) {
            ctx.moveTo(star.x + r, star.y);
            ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
        }
    }
    ctx.fillStyle = 'rgba(4, 6, 16, 0.82)';
    ctx.fill('evenodd');

    // Spotlight glow inside every pool of starlight, brightest at its
    // center, so safe ground reads as *lit* rather than merely not-dark.
    for (const star of stars) {
        const r = starLightRadius(star, now, params);
        if (r > 0) {
            const g = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, r);
            g.addColorStop(0, 'rgba(255, 250, 215, 0.2)');
            g.addColorStop(0.65, 'rgba(255, 250, 215, 0.07)');
            g.addColorStop(1, 'rgba(255, 250, 215, 0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    for (const star of stars) {
        const age = now - star.spawn;
        if (age < params.twinkleMs) {
            const dangerFrac = age / params.twinkleMs;

            // Explosion-radius telegraph: a reddish ring at the exact blast
            // radius, filling in as detonation nears, so a star landing in
            // your safe pool warns you which ground to vacate.
            ctx.globalAlpha = 0.12 + 0.25 * dangerFrac;
            ctx.fillStyle = '#ff6a6a';
            ctx.beginPath();
            ctx.arc(star.x, star.y, params.starBlastRadius * (0.4 + 0.6 * dangerFrac), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.3 + 0.5 * dangerFrac;
            ctx.strokeStyle = '#ff8a8a';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.arc(star.x, star.y, params.starBlastRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Twinkle telegraph: a four-point sparkle that grows and pulses
            // faster as the explosion nears.
            const size = 4 + dangerFrac * 8;
            ctx.globalAlpha = 0.45 + 0.45 * Math.abs(Math.sin(now / (140 - 90 * dangerFrac)));
            ctx.strokeStyle = '#fff7d0';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(star.x - size, star.y);
            ctx.lineTo(star.x + size, star.y);
            ctx.moveTo(star.x, star.y - size);
            ctx.lineTo(star.x, star.y + size);
            ctx.stroke();
        } else {
            const sinceBoom = age - params.twinkleMs;
            if (sinceBoom < 250) {
                // The explosion itself: a bright expanding ring over the blast radius.
                const p = sinceBoom / 250;
                ctx.globalAlpha = 1 - p;
                ctx.strokeStyle = '#fffbe8';
                ctx.lineWidth = 4 * (1 - p) + 1;
                ctx.beginPath();
                ctx.arc(star.x, star.y, params.starBlastRadius * p, 0, Math.PI * 2);
                ctx.stroke();
            }
            // Rim of the shrinking light pool.
            const r = starLightRadius(star, now, params);
            if (r > 0) {
                ctx.globalAlpha = 0.35;
                ctx.strokeStyle = '#e8f0ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }
    ctx.globalAlpha = 1;
}

// Moon phase, second layer: the sweeping moonbeams (server-broadcast angles
// in mech.beams + a shared pulse in mech.glow). Faint while telegraphing,
// bright with glowing edges while active — the "about to be harmful" tell —
// and drawn over the darkness so they visibly slice through the safe pools.
function drawMoonbeams(view, entry, boss) {
    const mech = view.mech;
    if (!mech || !mech.beams) return;
    const w = entry.params.width;
    const active = mech.glow >= entry.params.activeGlow;

    ctx.save();
    for (const beam of mech.beams) {
        ctx.globalAlpha = active ? 0.16 + 0.24 * mech.glow : 0.05 + 0.07 * mech.glow;
        ctx.fillStyle = active ? '#cfe4ff' : '#8fa2c4';
        ctx.beginPath();
        ctx.moveTo(boss.x, boss.y);
        ctx.arc(boss.x, boss.y, RAY_LENGTH, beam - w / 2, beam + w / 2);
        ctx.closePath();
        ctx.fill();

        if (active) {
            ctx.globalAlpha = 0.4 + 0.4 * mech.glow;
            ctx.strokeStyle = '#eaf3ff';
            ctx.lineWidth = 2;
            ctx.shadowColor = '#9fc3ff';
            ctx.shadowBlur = 12;
            for (const side of [-1, 1]) {
                const edge = beam + side * w / 2;
                ctx.beginPath();
                ctx.moveTo(boss.x, boss.y);
                ctx.lineTo(boss.x + Math.cos(edge) * RAY_LENGTH, boss.y + Math.sin(edge) * RAY_LENGTH);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
        }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
}

// Orb phase: the two halves' signature attacks, all timed client-side and
// held in the mechanic's scratch (entry.state) so this draws exactly what
// twinHalves in mechanics.js will hit with. The sun's charging/firing laser
// and the moon's about-to-burst stars.
function drawTwinHalves(view, entry) {
    const now = performance.now();
    const p = entry.params;
    const s = entry.state;

    if (s.laser) {
        const { ox, oy, ang } = s.laser;
        const ex = ox + Math.cos(ang) * RAY_LENGTH, ey = oy + Math.sin(ang) * RAY_LENGTH;
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        ctx.save();
        if (!s.laser.fired) {
            // Charging: a thin dashed line thickening/brightening toward the shot.
            const frac = Math.min(1, (now - s.laser.chargeStart) / p.laserChargeMs);
            ctx.globalAlpha = 0.3 + 0.5 * frac;
            ctx.strokeStyle = '#ffd24d';
            ctx.lineWidth = 1 + 3 * frac;
            ctx.shadowColor = '#ffcc44';
            ctx.shadowBlur = 8 + 12 * frac;
            ctx.setLineDash([10, 8]);
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.5 * frac;
            ctx.fillStyle = '#fff0b0';
            ctx.beginPath();
            ctx.arc(ox, oy, 6 + 10 * frac, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Fired: the wider beam, a bright band fading over its active window.
            const fade = 1 - Math.min(1, (now - s.laser.fireAt) / p.laserActiveMs);
            const hw = p.laserHalfWidth;
            const g = ctx.createLinearGradient(ox - nx * hw, oy - ny * hw, ox + nx * hw, oy + ny * hw);
            g.addColorStop(0, 'rgba(255, 210, 80, 0)');
            g.addColorStop(0.5, 'rgba(255, 245, 200, 0.95)');
            g.addColorStop(1, 'rgba(255, 210, 80, 0)');
            ctx.globalAlpha = 0.85 * fade;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(ox + nx * hw, oy + ny * hw);
            ctx.lineTo(ox - nx * hw, oy - ny * hw);
            ctx.lineTo(ex - nx * hw, ey - ny * hw);
            ctx.lineTo(ex + nx * hw, ey + ny * hw);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = fade;
            ctx.strokeStyle = '#fffdf4';
            ctx.lineWidth = 3;
            ctx.shadowColor = '#ffcc44';
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
        }
        ctx.restore();
    }

    for (const st of (s.breakStars || [])) {
        const frac = Math.min(1, (now - st.spawn) / p.starBreakMs);
        const size = 6 + frac * 8;
        ctx.save();
        // Cardinal ticks previewing the four directions it's about to fire.
        ctx.globalAlpha = 0.5 + 0.4 * Math.abs(Math.sin(now / 120));
        ctx.strokeStyle = '#8fd6ff';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#8fd6ff';
        ctx.shadowBlur = 8;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            ctx.beginPath();
            ctx.moveTo(st.x + dx * 4, st.y + dy * 4);
            ctx.lineTo(st.x + dx * size, st.y + dy * size);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#cdeaff';
        ctx.beginPath();
        ctx.arc(st.x, st.y, 3 + frac * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

// Eclipse (over layer): the corona blazing behind, the sun disc, the moon
// disc sliding over it as mech.moonT ramps 0..1, the boss riding on top of
// the stacked discs once totality hits, and the recurring blind flash.
const ECLIPSE_MOON_START = { x: 170, y: -120 }; // where the disc slides in from, relative to the boss

function drawEclipse(view, entry, boss, encounterId, bossState) {
    const { params, state } = entry;
    const now = performance.now();
    const moonT = view.mech ? view.mech.moonT : 1;

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, boss.radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // The sun disc the moon is about to swallow.
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, boss.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#10121c';
    ctx.strokeStyle = '#5a6480';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(boss.x + ECLIPSE_MOON_START.x * (1 - moonT), boss.y + ECLIPSE_MOON_START.y * (1 - moonT), boss.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // The huge corona beam: telegraphs as a wide dim wedge while charging,
    // then a searing band while it fires. Geometry (origin/angle/half-width)
    // matches isInBeam in the eclipse mechanic exactly.
    if (state.beam && state.beam.hw) {
        const b = state.beam;
        const ex = boss.x + Math.cos(b.ang) * RAY_LENGTH, ey = boss.y + Math.sin(b.ang) * RAY_LENGTH;
        const nx = -Math.sin(b.ang), ny = Math.cos(b.ang);
        const poly = () => {
            ctx.beginPath();
            ctx.moveTo(boss.x + nx * b.hw, boss.y + ny * b.hw);
            ctx.lineTo(boss.x - nx * b.hw, boss.y - ny * b.hw);
            ctx.lineTo(ex - nx * b.hw, ey - ny * b.hw);
            ctx.lineTo(ex + nx * b.hw, ey + ny * b.hw);
            ctx.closePath();
        };
        ctx.save();
        if (now - b.start < params.beamChargeMs) {
            const frac = (now - b.start) / params.beamChargeMs;
            ctx.globalAlpha = 0.08 + 0.16 * frac;
            ctx.fillStyle = '#ffcc66';
            poly();
            ctx.fill();
            ctx.globalAlpha = 0.35 + 0.45 * frac;
            ctx.strokeStyle = '#ffe08a';
            ctx.lineWidth = 2;
            ctx.setLineDash([16, 12]);
            for (const side of [-1, 1]) {
                ctx.beginPath();
                ctx.moveTo(boss.x + side * nx * b.hw, boss.y + side * ny * b.hw);
                ctx.lineTo(ex + side * nx * b.hw, ey + side * ny * b.hw);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        } else {
            const fade = b.fireAt ? 1 - Math.min(1, (now - b.fireAt) / params.beamActiveMs) : 1;
            const g = ctx.createLinearGradient(boss.x + nx * b.hw, boss.y + ny * b.hw, boss.x - nx * b.hw, boss.y - ny * b.hw);
            g.addColorStop(0, 'rgba(255, 200, 80, 0)');
            g.addColorStop(0.5, 'rgba(255, 250, 220, 0.92)');
            g.addColorStop(1, 'rgba(255, 200, 80, 0)');
            ctx.globalAlpha = 0.9 * fade;
            ctx.fillStyle = g;
            ctx.shadowColor = '#ffcc44';
            ctx.shadowBlur = 26;
            poly();
            ctx.fill();
        }
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    // Once totality hits, the boss itself rides on top of the stacked sun
    // and moon discs instead of being swallowed by them.
    if (moonT >= 1) {
        const sprite = bossSpriteFor(encounterId, bossState);
        if (sprite) {
            ctx.drawImage(sprite, boss.x - boss.radius, boss.y - boss.radius, boss.radius * 2, boss.radius * 2);
        }
    }

    // Totality blinds: a full white-out fading back over blindMs. The
    // timestamp is stamped (and periodically re-stamped — totality keeps
    // flashing every blindIntervalMs) by the eclipse mechanic, so the flash
    // and the firing pause share one clock.
    if (state.blindStart) {
        const p = (now - state.blindStart) / params.blindMs;
        if (p < 1) {
            ctx.globalAlpha = 1 - p;
            ctx.fillStyle = '#fffdf4';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
        }
    }
}

// --- Bombardment's launchCodes mechanic ------------------------------------
// Each player's maze occupies its own slice of the shared 800x600 canvas
// (see mazeSlots in server/phases.js), so ships/collisions need no special
// coordinate handling — the maze is just terrain that happens to be lethal.
// Layout is static for the phase (sent once as 'mazeLayout'); only the
// countdown (mech.mazeTimeLeft) updates every tick.
function drawMazes(view, myId) {
    const { maze, mech } = view;
    if (!maze || !maze.mazes) return;

    for (const id in maze.mazes) {
        const m = maze.mazes[id];
        ctx.globalAlpha = Number(id) === myId ? 1 : 0.5;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.fillRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);

        ctx.strokeStyle = '#9fe6ff';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (const w of m.walls) {
            ctx.beginPath();
            ctx.moveTo(w.x1, w.y1);
            ctx.lineTo(w.x2, w.y2);
            ctx.stroke();
        }
        ctx.lineCap = 'butt';

        ctx.globalAlpha *= 0.6 + 0.4 * Math.sin(performance.now() / 200);
        ctx.strokeStyle = '#4dff88';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(m.exit.x, m.exit.y, m.cellSize * 0.3, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (mech && mech.mazeGraceLeft != null) {
        // Grace countdown: a big center-screen number so it reads instantly
        // even mid-panic, counting down to the moment walls turn lethal.
        ctx.textAlign = 'center';
        ctx.font = 'bold 64px impact';
        ctx.fillStyle = '#ffdd55';
        ctx.fillText(Math.ceil(mech.mazeGraceLeft / 1000).toString(), canvas.width / 2, canvas.height / 2 - 40);
        ctx.font = 'bold 20px impact';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('DEFUSE THE BOMB', canvas.width / 2, canvas.height / 2);
        ctx.textAlign = 'left';
    } else if (mech && mech.mazeTimeLeft != null) {
        ctx.font = 'bold 28px impact';
        ctx.textAlign = 'center';
        ctx.fillStyle = mech.mazeTimeLeft < 5000 ? '#ff5555' : '#ffffff';
        ctx.fillText(`${(mech.mazeTimeLeft / 1000).toFixed(1)}s`, canvas.width / 2, 30);
        ctx.textAlign = 'left';
    }
}

// A phase can run several mechanics at once (view.mechanics, in encounter
// order) — each draws its own layer, so e.g. solar flares paint over the
// moon shadow they burn through.
function drawMechanicUnder(view, boss, myId) {
    if (!view) return;
    for (const entry of view.mechanics) {
        if (entry.name === 'sunRays') drawSunPhase(view, entry, boss);
        else if (entry.name === 'solarFlares') drawSolarFlares(view, entry, boss);
        else if (entry.name === 'maze') drawMazes(view, myId);
    }
}

function drawMechanicOver(view, boss, encounterId, bossState) {
    if (!view) return;
    for (const entry of view.mechanics) {
        if (entry.name === 'starfield') drawMoonPhase(view, entry, boss);
        else if (entry.name === 'moonbeams') drawMoonbeams(view, entry, boss);
        else if (entry.name === 'twinHalves') drawTwinHalves(view, entry);
        else if (entry.name === 'eclipse') drawEclipse(view, entry, boss, encounterId, bossState);
    }
}

// Bombardment hazards: the boss visibly fires a rocket that arcs offscreen,
// then — once it's out of view — a pulsing telegraph ring appears on the
// ground where it'll land (filling in as impact nears, so the warning is
// most solid right when it matters), then the rocket reappears falling back
// down and impacts in a bright ring that expands and fades.
function drawMissiles(missiles, boss) {
    const now = performance.now();
    for (const m of missiles) {
        if (!m.exploded) {
            const sinceSpawn = now - m.spawnTime;
            const untilImpact = m.impactTime - now;

            if (sinceSpawn < ROCKET_FLIGHT_MS) {
                // Ascending from the boss, arcing toward the target's x so it
                // reads as "fired at" the landing spot rather than straight up.
                const t = Math.max(0, Math.min(1, sinceSpawn / ROCKET_FLIGHT_MS));
                const rx = boss.x + (m.x - boss.x) * t;
                const ry = boss.y + (OFFSCREEN_Y - boss.y) * t;
                drawRocket(rx, ry, Math.atan2(OFFSCREEN_Y - boss.y, m.x - boss.x));
            } else if (untilImpact >= 0 && untilImpact < ROCKET_FLIGHT_MS) {
                // Falling back down onto its mark.
                const t = 1 - Math.max(0, Math.min(1, untilImpact / ROCKET_FLIGHT_MS));
                const ry = OFFSCREEN_Y + (m.y - OFFSCREEN_Y) * t;
                drawRocket(m.x, ry, Math.PI / 2);
            }

            // The ground telegraph only appears once the rocket has actually
            // left the screen — showing it while the rocket is still visibly
            // ascending would spoil/clutter the "it's now offscreen" beat.
            if (sinceSpawn >= ROCKET_FLIGHT_MS) {
                const total = m.impactTime - m.spawnTime;
                const remainingFrac = total > 0 ? Math.max(0, Math.min(1, (m.impactTime - now) / total)) : 0;
                const dangerFrac = 1 - remainingFrac; // 0 once offscreen, 1 right at impact

                ctx.globalAlpha = (0.35 + 0.25 * dangerFrac) + 0.2 * Math.sin(now / 90);
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.globalAlpha = 0.25 + 0.45 * dangerFrac;
                ctx.fillStyle = '#ff8844';
                ctx.beginPath();
                ctx.arc(m.x, m.y, m.radius * dangerFrac, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            if (!m.shaken) {
                m.shaken = true;
                shakeEndTime = now + SHAKE_DURATION;
            }

            const p = Math.min(1, (now - m.explodedAt) / MISSILE_EXPLOSION_DURATION);
            ctx.globalAlpha = 1 - p;
            ctx.strokeStyle = '#ffaa33';
            ctx.lineWidth = 5 * (1 - p) + 1;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.radius * p, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;
}

let flashEndTime = 0;
const FLASH_DURATION = 120; // ms, the screen-wide brightness pulse on a lightning strike

let explosionShakeEndTime = 0;
let explosionFlashEndTime = 0;
const EXPLOSION_SHAKE_DURATION = 700; // ms, longer/harder than a regular missile/lightning hit
const EXPLOSION_SHAKE_MAGNITUDE = 22; // px
const EXPLOSION_FLASH_DURATION = 550; // ms

// Bombardment's launchCodes maze: if the whole party runs out the clock
// (see the launchCodes timeout in server/phases.js), every screen erupts
// together rather than each death reading as a quiet, separate grave.
export function triggerScreenExplosion() {
    const now = performance.now();
    explosionShakeEndTime = now + EXPLOSION_SHAKE_DURATION;
    explosionFlashEndTime = now + EXPLOSION_FLASH_DURATION;
}

// Storm lightning: a dashed vertical bar telegraphs the strike column, then
// a jagged bolt (regenerated fresh per strike so it never repeats) flashes
// in as the actual hitbox, paired with a screen shake + brightness pulse.
function drawLightning(bolts) {
    const now = performance.now();
    for (const bolt of bolts) {
        if (!bolt.struck) {
            const dangerFrac = Math.max(0, Math.min(1, (now - bolt.spawnTime) / LIGHTNING_WARNING_MS));
            ctx.globalAlpha = (0.15 + 0.35 * dangerFrac) + 0.15 * Math.sin(now / 60);
            ctx.strokeStyle = '#fff7cc';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 6]);
            ctx.beginPath();
            ctx.moveTo(bolt.x, 0);
            ctx.lineTo(bolt.x, 600);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            if (!bolt.shaken) {
                bolt.shaken = true;
                shakeEndTime = now + SHAKE_DURATION * 1.4;
                flashEndTime = now + FLASH_DURATION;
                // Jagged path down the screen, generated once so it holds
                // steady for the strike's full duration instead of jittering.
                bolt.points = [];
                let x = bolt.x, y = 0;
                while (y < 600) {
                    y += 26 + Math.random() * 28;
                    x += (Math.random() - 0.5) * 26;
                    bolt.points.push({ x, y: Math.min(y, 600) });
                }
            }

            const p = Math.min(1, (now - bolt.strikeTime) / LIGHTNING_STRIKE_MS);
            ctx.globalAlpha = 0.25 * (1 - p);
            ctx.fillStyle = '#eaffff';
            ctx.fillRect(bolt.x - LIGHTNING_WIDTH, 0, LIGHTNING_WIDTH * 2, 600);

            ctx.globalAlpha = (1 - p) * (0.75 + 0.25 * Math.random());
            ctx.strokeStyle = '#eaffff';
            ctx.lineWidth = 4 * (1 - p) + 2;
            ctx.shadowColor = '#aef';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.moveTo(bolt.x, 0);
            for (const pt of bolt.points) ctx.lineTo(pt.x, pt.y);
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
    }
    ctx.globalAlpha = 1;
}

let lastDrawTime = performance.now();

export function draw(myId, players, bullets, allyBullets, bossBullets, bossMissiles, bossLightning, boss, damagePopups, graves, orbs, phaseDef, stormUmbrellaActive, mechView, encounterId, bossState) {
    // Reset any transform left over from a previous shaking frame before
    // clearing, so the clear always covers the full physical canvas.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const dt = Math.min((now - lastDrawTime) / 1000, 0.1);
    lastDrawTime = now;

    if (now < shakeEndTime) {
        const remaining = (shakeEndTime - now) / SHAKE_DURATION;
        ctx.translate((Math.random() - 0.5) * 2 * SHAKE_MAGNITUDE * remaining, (Math.random() - 0.5) * 2 * SHAKE_MAGNITUDE * remaining);
    }
    if (now < explosionShakeEndTime) {
        const remaining = (explosionShakeEndTime - now) / EXPLOSION_SHAKE_DURATION;
        ctx.translate((Math.random() - 0.5) * 2 * EXPLOSION_SHAKE_MAGNITUDE * remaining, (Math.random() - 0.5) * 2 * EXPLOSION_SHAKE_MAGNITUDE * remaining);
    }

    // Storm's umbrella, drawn early so players/bullets render on top of it.
    drawStormUmbrella(!!stormUmbrellaActive, dt);

    // Ground-level mechanic zones (sun rays, the moon's shadow, launchCodes'
    // mazes) — under everything so entities read on top of them.
    drawMechanicUnder(mechView, boss, myId);

    // Old permanent grave markers are hidden for now — death is revivable,
    // so a gravestone is drawn at each currently-dead player instead (below).

    // Boss — a sprite (see bossSpriteFor) is drawn if one exists for this
    // encounter/state, otherwise it falls back to a plain circle tinted by
    // the phase (e.g. red during the enrage chase, as a readable signal that
    // it's now mobile and firing aimed shots).
    const bossSprite = bossSpriteFor(encounterId, bossState);
    if (bossSprite) {
        const size = boss.radius * 2;
        ctx.drawImage(bossSprite, boss.x - boss.radius, boss.y - boss.radius, size, size);
    } else {
        ctx.fillStyle = (phaseDef && phaseDef.bossTint) || 'gray';
        ctx.beginPath();
        ctx.arc(boss.x, boss.y, boss.radius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Boss health bar
    if (boss.maxHp) {
        const bossHealthPct = Math.max(0, boss.hp / boss.maxHp);
        ctx.fillStyle = `hsl(${bossHealthPct * 120}, 100%, 50%)`;
        ctx.fillRect(boss.x - boss.radius, boss.y - boss.radius - 15, boss.radius * 2 * bossHealthPct, 6);
        ctx.strokeStyle = 'black';
        ctx.strokeRect(boss.x - boss.radius, boss.y - boss.radius - 15, boss.radius * 2, 6);
    }

    // Twin orbs (orb-phase co-op targets); dead orbs linger as faded husks so
    // players can see what still needs to drop before the revive window closes
    if (orbs) {
        const ORB_RADIUS = 18;
        // Orbs can carry a kind (twin's sun/moon pair); plain orbs stay violet.
        // The sun half glows yellow, the moon half light blue.
        const ORB_COLORS = { sun: '#ffd24d', moon: '#7fd0ff' };
        const ORB_GLOW = { sun: 'rgba(255, 200, 60, 0.55)', moon: 'rgba(120, 200, 255, 0.55)' };
        for (const orb of orbs) {
            const alive = orb.hp > 0;
            ctx.globalAlpha = alive ? 1 : 0.25;

            // Soft radial halo in the half's color so the two read as the sun
            // and the moon well before their phases arrive.
            if (alive && ORB_GLOW[orb.kind]) {
                const gr = ctx.createRadialGradient(orb.x, orb.y, ORB_RADIUS * 0.5, orb.x, orb.y, ORB_RADIUS * 2.3);
                gr.addColorStop(0, ORB_GLOW[orb.kind]);
                gr.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = gr;
                ctx.beginPath();
                ctx.arc(orb.x, orb.y, ORB_RADIUS * 2.3, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.fillStyle = ORB_COLORS[orb.kind] || 'violet';
            ctx.beginPath();
            ctx.arc(orb.x, orb.y, ORB_RADIUS, 0, Math.PI * 2);
            ctx.fill();

            if (alive) {
                const pct = orb.hp / orb.maxHp;
                ctx.fillStyle = `hsl(${pct * 120}, 100%, 50%)`;
                ctx.fillRect(orb.x - ORB_RADIUS, orb.y - ORB_RADIUS - 12, ORB_RADIUS * 2 * pct, 5);
                ctx.strokeStyle = 'black';
                ctx.strokeRect(orb.x - ORB_RADIUS, orb.y - ORB_RADIUS - 12, ORB_RADIUS * 2, 5);
            }
        }
        ctx.globalAlpha = 1;
    }

    // Players
    const PLAYER_RADIUS = 10;
    const OTHER_PLAYER_ALPHA = 0.5; // teammates render less prominently than you

    for (const p of players) {
        ctx.globalAlpha = p.id === myId ? 1 : OTHER_PLAYER_ALPHA;

        if (p.dead) {
            drawGravestone(p.x, p.y, p.color);

            // Revive progress ring while a teammate stands on the body
            if (p.revive > 0) {
                ctx.strokeStyle = '#4f4';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(p.x, p.y, PLAYER_RADIUS + 6, -Math.PI / 2, -Math.PI / 2 + p.revive * Math.PI * 2);
                ctx.stroke();
                ctx.lineWidth = 1;
            }

            if (p.name) {
                ctx.font = '12px calibri';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#aaa';
                ctx.fillText(p.name, p.x, p.y - 26);
                ctx.textAlign = 'left';
            }
            continue;
        }

        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // Launch codes: a green ring marks a player who's already cleared
        // their maze and is just waiting on the rest of the team.
        if (p.finished) {
            ctx.strokeStyle = '#4dff88';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, PLAYER_RADIUS + 4, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Name tag
        if (p.name) {
            ctx.font = '12px calibri';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'white';
            ctx.fillText(p.name, p.x, p.y - 26);
            ctx.textAlign = 'left';
        }

        // Health bar
        const healthPercentage = p.health / 100;
        const hue = healthPercentage * 120;
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.fillRect(p.x - 15, p.y - 20, 30 * healthPercentage, 5);
        ctx.strokeStyle = 'black';
        ctx.strokeRect(p.x - 15, p.y - 20, 30, 5);
    }
    ctx.globalAlpha = 1;

    // Bullets (always the local player's — bullets are simulated client-side only)
    const me = players.find(p => p.id === myId);
    for (const b of bullets) {
        ctx.fillStyle = me?.color || 'white';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // Ally bullets (relayed shot origins, simulated locally) render less
    // prominently than the local player's own bullets
    ctx.globalAlpha = 0.45;
    for (const b of allyBullets) {
        ctx.fillStyle = b.color || 'white';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Boss Bullets — one color/size per attack type so patterns read
    // distinctly. Types with a `trail` color get a pointy speed trail behind
    // every bullet of that type (the value is the trail's fully-faded end
    // color, i.e. the bullet color at alpha 0, so the gradient fades cleanly).
    const BULLET_STYLES = {
        1: { color: 'cyan', size: 6, trail: 'rgba(0, 255, 255, 0)' },        // circular ring
        2: { color: 'red', size: 20 },                                       // big red ball
        3: { color: 'orange', size: 8, trail: 'rgba(255, 165, 0, 0)' },      // enrage-chase aimed shots
        4: { color: 'magenta', size: 5 },                                    // spiral arms
        5: { color: 'gold', size: 5 },                                       // sweeping wave fan
        6: { color: 'greenyellow', size: 5 },                                // acid rain droplets
        8: { color: '#e8d5ff', size: 6, trail: 'rgba(232, 213, 255, 0)' },   // eclipse corona arcs
        9: { color: '#dfefff', size: 5, trail: 'rgba(223, 239, 255, 0)' },   // twin phase-1 falling stars
        10: { color: '#8fd6ff', size: 6, trail: 'rgba(143, 214, 255, 0)' }   // moon half's cardinal burst
    };
    for (const b of bossBullets) {
        if (b.type === 7) {
            // Storm rain: a short streak along its own velocity instead of a
            // dot, so wind-driven drift reads visually as slanting rain.
            const speed = Math.hypot(b.dx, b.dy) || 1;
            ctx.globalAlpha = 0.85;
            ctx.strokeStyle = '#bcd9ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x - (b.dx / speed) * 10, b.y - (b.dy / speed) * 10);
            ctx.stroke();
            ctx.globalAlpha = 1;
            continue;
        }
        const style = BULLET_STYLES[b.type] || { color: 'white', size: b.size || 5 };
        // Pointy speed trail: a filled triangle whose sides leave the
        // bullet's circle tangentially and converge to a tip behind it,
        // fading to transparent along the way. Drawn under the bullet body.
        if (style.trail) {
            const speed = Math.hypot(b.dx, b.dy) || 1;
            const len = style.size * 2 + speed * 7; // tip distance behind the center
            const backAng = Math.atan2(-b.dy, -b.dx);
            const tipX = b.x + Math.cos(backAng) * len;
            const tipY = b.y + Math.sin(backAng) * len;
            // Where a line from the tip just grazes the circle: rotated
            // acos(r/len) away from straight-back, one per side.
            const graze = Math.acos(Math.min(1, style.size / len));
            const g = ctx.createLinearGradient(b.x, b.y, tipX, tipY);
            g.addColorStop(0, style.color);
            g.addColorStop(1, style.trail);
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(b.x + Math.cos(backAng + graze) * style.size, b.y + Math.sin(backAng + graze) * style.size);
            ctx.lineTo(b.x + Math.cos(backAng - graze) * style.size, b.y + Math.sin(backAng - graze) * style.size);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, style.size, 0, Math.PI * 2);
        ctx.fill();
    }

    drawMissiles(bossMissiles, boss);
    if (bossLightning) drawLightning(bossLightning);

    // Scene-covering mechanic effects (the moon phase's darkness, the
    // eclipse discs and blind flash) — over the entities they dim, but under
    // the damage popups so those stay readable.
    drawMechanicOver(mechView, boss, encounterId, bossState);

    // A lightning strike briefly brightens the whole scene.
    const nowFlash = performance.now();
    if (nowFlash < flashEndTime) {
        ctx.globalAlpha = ((flashEndTime - nowFlash) / FLASH_DURATION) * 0.35;
        ctx.fillStyle = '#eaffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
    }

    // Whole-party wipe on a launchCodes timeout: a hard red-white flash,
    // bigger and slower to fade than a routine hit's flash above.
    if (nowFlash < explosionFlashEndTime) {
        ctx.globalAlpha = ((explosionFlashEndTime - nowFlash) / EXPLOSION_FLASH_DURATION) * 0.85;
        ctx.fillStyle = '#ff3300';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
    }

    // Damage Popups
    for (let i = damagePopups.length - 1; i >= 0; i--) {
        const d = damagePopups[i];
        ctx.globalAlpha = d.alpha;
        ctx.font = '24px impact';
        ctx.fillStyle = d.color; // shadow color
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 1;
        ctx.fillText(d.amount, d.x, d.y);
        ctx.fillStyle = 'white'; // main dmg number color
        ctx.fillText(d.amount, d.x - 2, d.y - 2);
        ctx.shadowBlur = 0;
        d.y += d.dy * 2;
        d.alpha -= 0.01;
        if (d.alpha <= 0) damagePopups.splice(i, 1);
    }
    ctx.globalAlpha = 1; // Reset alpha
}