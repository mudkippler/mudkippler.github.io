const barEl = document.getElementById('boss-bar');
const nameEl = document.getElementById('boss-bar-name');
const subtitleEl = document.getElementById('boss-bar-subtitle');
const fillEl = document.getElementById('boss-bar-fill');
const hpTextEl = document.getElementById('boss-bar-hp-text');

// Per-encounter flair: an icon + accent color for the name/glow, so each
// fight reads as its own identity at a glance rather than a generic bar.
const FLAIR = {
    twin: { icon: '⚔', color: '#ffd24d' },
    storm: { icon: '⚡', color: '#4dd2ff' },
    blitz: { icon: '🔥', color: '#ff6a3d' },
    helix: { icon: '🌀', color: '#e14dff' },
    tide: { icon: '🌊', color: '#4da6ff' },
    rain: { icon: '☣', color: '#9dff4d' },
    bombardment: { icon: '💥', color: '#ff8844' }
};
const DEFAULT_FLAIR = { icon: '☠', color: '#ff6a3d' };

// Shared with the chat panel so boss speech lines pick up the same
// encounter-specific accent color as the health bar/name above the playfield.
export function getFlairColor(encounterId) {
    return (FLAIR[encounterId] || DEFAULT_FLAIR).color;
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// Tints the page background (everything outside the playfield) with a
// per-encounter pattern — see the .encounter-* rules in index.html. Just
// sets a CSS var + a class; the actual gradients live in CSS so this stays cheap.
export function applyBackgroundTheme(encounterId) {
    const flair = FLAIR[encounterId] || DEFAULT_FLAIR;
    document.body.style.setProperty('--flair-color', flair.color);
    document.body.style.setProperty('--flair-rgb', hexToRgb(flair.color));
    document.body.className = encounterId ? `encounter-${encounterId}` : '';
}

export function updateBossBar(encounter, boss, phaseDef, inGame) {
    barEl.style.display = inGame ? 'block' : 'none';
    if (!inGame || !encounter) return;
    phaseDef = phaseDef || {};

    const flair = FLAIR[encounter.id] || DEFAULT_FLAIR;
    nameEl.textContent = `${flair.icon} ${encounter.name} ${flair.icon}`;
    nameEl.style.color = flair.color;
    nameEl.style.textShadow = `0 0 10px ${flair.color}, 0 0 18px ${flair.color}`;

    subtitleEl.textContent = phaseDef.subtitle || '';

    const maxHp = boss.maxHp || 1;
    const pct = Math.max(0, Math.min(1, (boss.hp || 0) / maxHp));
    fillEl.style.width = `${pct * 100}%`;
    // The bar recolors with the phase's mood: gray once won, burnt orange
    // while the boss rages, red otherwise.
    fillEl.style.background = phaseDef.victory
        ? 'linear-gradient(180deg, #777, #333)'
        : phaseDef.portrait === 'enraged'
            ? 'linear-gradient(180deg, #ff8a4d, #b32d00)'
            : 'linear-gradient(180deg, #f66, #a11)';
    hpTextEl.textContent = phaseDef.victory ? 'DEFEATED' : `${Math.max(0, Math.ceil(boss.hp || 0))} / ${maxHp}`;
}
