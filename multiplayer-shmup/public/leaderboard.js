const listEl = document.getElementById('leaderboard-list');

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function updateLeaderboard(myId, fullDamageLog) {
    const entries = Object.entries(fullDamageLog).sort((a, b) => b[1].dmg - a[1].dmg);
    // Player names are user-supplied, so escape before interpolating into innerHTML.
    listEl.innerHTML = entries.map(([id, entry]) => `
        <li>
            <span class="lb-dot" style="background:${entry.color || 'white'}"></span>
            <span class="lb-name">${escapeHtml(entry.name || id)}${Number(id) === myId ? ' (you)' : ''}</span>
            <span class="lb-dmg">${Math.floor(entry.dmg)}</span>
        </li>
    `).join('');
}
