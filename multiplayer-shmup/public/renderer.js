import { MISSILE_EXPLOSION_DURATION, LIGHTNING_WARNING_MS, LIGHTNING_STRIKE_MS, LIGHTNING_WIDTH, STORM_UMBRELLA_X, STORM_UMBRELLA_Y, STORM_UMBRELLA_HALF_WIDTH } from './attacks.js';
import { starLightRadius } from './mechanics.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

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
function drawSunPhase(view, boss) {
    const { mech, params } = view;
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

// Moon phase (over layer): pitch-black darkness with even-odd holes punched
// out for every light source, then the stars' twinkles, explosions, and
// light-pool rims drawn on top so they stay visible in the dark.
function drawMoonPhase(view, boss) {
    const { stars, params } = view;
    const now = performance.now();

    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.moveTo(boss.x + params.moonGlowRadius, boss.y);
    ctx.arc(boss.x, boss.y, params.moonGlowRadius, 0, Math.PI * 2);
    for (const star of stars) {
        const r = starLightRadius(star, now, params);
        if (r > 0) {
            ctx.moveTo(star.x + r, star.y);
            ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
        }
    }
    ctx.fillStyle = 'rgba(4, 6, 16, 0.82)';
    ctx.fill('evenodd');

    // Moonlight rim around the boss's own glow.
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#cdd6e8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, params.moonGlowRadius, 0, Math.PI * 2);
    ctx.stroke();

    for (const star of stars) {
        const age = now - star.spawn;
        if (age < params.twinkleMs) {
            // Twinkle telegraph: a four-point sparkle that grows and pulses
            // faster as the explosion nears.
            const dangerFrac = age / params.twinkleMs;
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

// Eclipse (over layer): the corona blazing behind, the moon disc sliding
// over the sun as mech.moonT ramps 0..1, and the totality blind flash.
const ECLIPSE_MOON_START = { x: 170, y: -120 }; // where the disc slides in from, relative to the boss

function drawEclipse(view, boss) {
    const { mech, params, state } = view;
    const now = performance.now();
    const moonT = mech ? mech.moonT : 1;

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, boss.radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#10121c';
    ctx.strokeStyle = '#5a6480';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(boss.x + ECLIPSE_MOON_START.x * (1 - moonT), boss.y + ECLIPSE_MOON_START.y * (1 - moonT), boss.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Totality blinds: a full white-out fading back over blindMs. The
    // timestamp is stamped by the eclipse mechanic the moment moonT hits 1,
    // so the flash and the firing pause share one clock.
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

function drawMechanicUnder(view, boss) {
    if (view && view.mechanic === 'sunRays') drawSunPhase(view, boss);
}

function drawMechanicOver(view, boss) {
    if (!view) return;
    if (view.mechanic === 'starfield') drawMoonPhase(view, boss);
    else if (view.mechanic === 'eclipse') drawEclipse(view, boss);
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

export function draw(myId, players, bullets, allyBullets, bossBullets, bossMissiles, bossLightning, boss, damagePopups, graves, orbs, phaseDef, stormUmbrellaActive, mechView) {
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

    // Storm's umbrella, drawn early so players/bullets render on top of it.
    drawStormUmbrella(!!stormUmbrellaActive, dt);

    // Ground-level mechanic zones (sun rays, the moon's shadow) — under
    // everything so entities read on top of them.
    drawMechanicUnder(mechView, boss);

    // Old permanent grave markers are hidden for now — death is revivable,
    // so a gravestone is drawn at each currently-dead player instead (below).

    // Boss — phases can tint the body (e.g. red during the enrage chase as a
    // readable signal that it's now mobile and firing aimed shots).
    ctx.fillStyle = (phaseDef && phaseDef.bossTint) || 'gray';
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, boss.radius, 0, Math.PI * 2);
    ctx.fill();

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
        const ORB_COLORS = { sun: '#ffd24d', moon: '#cdd6e8' };
        for (const orb of orbs) {
            const alive = orb.hp > 0;
            ctx.globalAlpha = alive ? 1 : 0.25;
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

    // Boss Bullets — one color/size per attack type so patterns read distinctly
    const BULLET_STYLES = {
        1: { color: 'cyan', size: 6 },        // circular ring
        2: { color: 'red', size: 20 },        // big red ball
        3: { color: 'orange', size: 8 },      // enrage-chase aimed shots
        4: { color: 'magenta', size: 5 },     // spiral arms
        5: { color: 'gold', size: 5 },        // sweeping wave fan
        6: { color: 'greenyellow', size: 5 }, // acid rain droplets
        8: { color: '#e8d5ff', size: 6 }      // eclipse corona rings
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
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, style.size, 0, Math.PI * 2);
        ctx.fill();
    }

    drawMissiles(bossMissiles, boss);
    if (bossLightning) drawLightning(bossLightning);

    // Scene-covering mechanic effects (the moon phase's darkness, the
    // eclipse disc and blind flash) — over the entities they dim, but under
    // the damage popups so those stay readable.
    drawMechanicOver(mechView, boss);

    // A lightning strike briefly brightens the whole scene.
    const nowFlash = performance.now();
    if (nowFlash < flashEndTime) {
        ctx.globalAlpha = ((flashEndTime - nowFlash) / FLASH_DURATION) * 0.35;
        ctx.fillStyle = '#eaffff';
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