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

export function draw(myId, players, bullets, allyBullets, bossBullets, boss, fullDamageLog, damagePopups, graves, orbs, bossMessage, phase) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Old permanent grave markers are hidden for now — death is revivable,
    // so a gravestone is drawn at each currently-dead player instead (below).

    // Boss — tinted red during the phase-3 enrage chase as a readable signal
    // that it's now mobile and firing aimed shots, not just standing still.
    ctx.fillStyle = phase === 3 ? '#a33' : 'gray';
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

    // Twin orbs (phase 2 co-op targets); dead orbs linger as faded husks so
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

    // Boss speech (fades out over its last second)
    if (bossMessage) {
        const remaining = bossMessage.expiresAt - performance.now();
        if (remaining > 0) {
            ctx.globalAlpha = Math.min(1, remaining / 1000);
            ctx.font = 'italic 22px impact';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'white';
            ctx.shadowColor = 'black';
            ctx.shadowBlur = 3;
            ctx.fillText(bossMessage.text, boss.x, boss.y - boss.radius - 28);
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
            ctx.textAlign = 'left';
        }
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
        3: { color: 'orange', size: 8 },      // phase-3 aimed shots
        4: { color: 'magenta', size: 5 },     // spiral arms
        5: { color: 'gold', size: 5 },        // sweeping wave fan
        6: { color: 'greenyellow', size: 5 }  // acid rain droplets
    };
    for (const b of bossBullets) {
        const style = BULLET_STYLES[b.type] || { color: 'white', size: b.size || 5 };
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, style.size, 0, Math.PI * 2);
        ctx.fill();
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

    // Leaderboard
    ctx.font = '2rem calibri ';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'white';
    ctx.fillText('Damage Leaderboard', 10, 35);

    let rankY = 65;
    // Entries are {name, color, dmg} keyed by player id (server-provided)
    for (const [id, entry] of Object.entries(fullDamageLog).sort((a, b) => b[1].dmg - a[1].dmg)) {
        ctx.fillStyle = entry.color || 'white';
        ctx.beginPath();
        ctx.arc(16, rankY - 7, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'white';
        ctx.fillText(`${entry.name || id} — ${Math.floor(entry.dmg)} dmg`, 30, rankY);
        rankY += 25;
    }

    // Draw self indicator (bottom center)
    if (me) {
        ctx.font = '16px impact';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'white';
        ctx.fillText('You are', canvas.width / 2, canvas.height - 15);

        // Draw a circle in your color
        ctx.beginPath();
        ctx.arc(canvas.width / 2 + 40, canvas.height - 25, 8, 0, Math.PI * 2);
        ctx.fillStyle = me.color;
        ctx.fill();
    }
}