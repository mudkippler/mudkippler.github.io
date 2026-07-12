const hud = document.getElementById('hud');

export function updateHUD(myId, players) {
    const me = players.find(p => p.id === myId);
    if (!me) return;

    const healthPercentage = Math.max(0, me.health) / 100;
    const hue = healthPercentage * 120; // 0 is red, 120 is green
    hud.innerHTML = `
        <div class="hud-row">
            <span class="hud-label">HP</span>
            <div class="hud-bar-track">
                <div class="hud-bar-fill" style="width: ${healthPercentage * 100}%; background: hsl(${hue}, 100%, 50%);"></div>
            </div>
            <span class="hud-value">${Math.max(0, Math.round(me.health))}</span>
        </div>
    `;
}