import { MISSILE_EXPLOSION_DURATION, LIGHTNING_WARNING_MS, LIGHTNING_STRIKE_MS, LIGHTNING_WIDTH, STORM_UMBRELLA_X, STORM_UMBRELLA_Y, STORM_UMBRELLA_HALF_WIDTH } from './attacks.js';

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

export function draw(myId, players, bullets, allyBullets, bossBullets, bossMissiles, bossLightning, boss, damagePopups, graves, orbs, phaseDef, stormUmbrellaActive) {
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
        for (const orb of orbs) {
            const alive = orb.hp > 0;
            ctx.globalAlpha = alive ? 1 : 0.25;
            ctx.fillStyle = 'violet';
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
        6: { color: 'greenyellow', size: 5 }  // acid rain droplets
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