const hud = document.getElementById('hud');

export function updateHUD(myId, players) {
    const me = players.find(p => p.id === myId);
    if (me) {
        const healthPercentage = me.health / 100;
        const hue = healthPercentage * 120; // 0 is red, 120 is green
        hud.innerHTML = `
            <div>Health:</div>
            <div style="width: 100%; background: #444; border-radius: 5px; overflow: hidden;">
                <div style="width: ${healthPercentage * 100}%; background: hsl(${hue}, 100%, 50%); height: 20px;"></div>
            </div>
        `;
    }
}