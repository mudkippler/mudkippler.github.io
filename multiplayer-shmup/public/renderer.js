const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

export function draw(myId, players, bullets, bossBullets, boss, fullDamageLog, damagePopups, graves, orbs, bossMessage) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grave markers (small crosses where players have died)
    if (graves) {
        const GRAVE_SIZE = 6;
        ctx.lineWidth = 2;
        for (const g of graves) {
            ctx.strokeStyle = g.color;
            ctx.beginPath();
            ctx.moveTo(g.x - GRAVE_SIZE, g.y - GRAVE_SIZE);
            ctx.lineTo(g.x + GRAVE_SIZE, g.y + GRAVE_SIZE);
            ctx.moveTo(g.x + GRAVE_SIZE, g.y - GRAVE_SIZE);
            ctx.lineTo(g.x - GRAVE_SIZE, g.y + GRAVE_SIZE);
            ctx.stroke();
        }
        ctx.lineWidth = 1;
    }

    // Boss
    ctx.fillStyle = 'gray';
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

    for (const p of players) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // Health bar
        const healthPercentage = p.health / 100;
        const hue = healthPercentage * 120;
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.fillRect(p.x - 15, p.y - 20, 30 * healthPercentage, 5);
        ctx.strokeStyle = 'black';
        ctx.strokeRect(p.x - 15, p.y - 20, 30, 5);
    }

    // Bullets (always the local player's — bullets are simulated client-side only)
    const me = players.find(p => p.id === myId);
    for (const b of bullets) {
        ctx.fillStyle = me?.color || 'white';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // Boss Bullets
    for (const b of bossBullets) {
        let color;
        let size;
        if (b.type === 1) {
            color = 'cyan';
            size = 6;
        } else if (b.type === 2) {
            color = 'red';
            size = 20;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, size, 0, Math.PI * 2);
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
    for (const [id, dmg] of Object.entries(fullDamageLog).sort((a, b) => b[1] - a[1])) {
        const player = players.find(p => String(p.id) === id);
        const color = player?.color || 'white';

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(16, rankY - 7, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillText(`${Math.floor(dmg)} dmg`, 30, rankY);
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