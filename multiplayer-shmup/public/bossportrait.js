// Boss portrait + dialogue bubble, shown to the left of the playfield.
// Portrait art is optional: drop these into public/img and they're picked up
// automatically (missing files just hide the portrait frame instead of
// showing a broken image):
//   img/<encounterId>.png            — HP above 50%
//   img/<encounterId>_injured.png    — HP at or below 50%
//   img/<encounterId>_enraged.png    — phases with portrait: 'enraged' (the enrage chase)
//   img/<encounterId>_defeat.png     — phases with portrait: 'defeat' (boss down)

const containerEl = document.getElementById('boss-dialogue');
const portraitImg = document.getElementById('boss-portrait-img');
const bubbleEl = document.getElementById('boss-dialogue-bubble');
const textEl = document.getElementById('boss-dialogue-text');

const STATE_SUFFIX = { base: '', injured: '_injured', enraged: '_enraged', defeat: '_defeat' };

let currentEncounterId = null;
let currentState = null;
let hideTimer = null;

portraitImg.onload = () => { portraitImg.style.display = 'block'; };
portraitImg.onerror = () => { portraitImg.style.display = 'none'; };

export function showBossDialogue(inGame) {
    containerEl.style.display = inGame ? 'block' : 'none';
}

// Derives which portrait state to show: phases can pin one via their
// `portrait` field (see server/encounters.js); otherwise it follows HP.
export function bossPortraitState(phaseDef, hp, maxHp) {
    if (phaseDef && phaseDef.portrait) return phaseDef.portrait;
    return hp / (maxHp || 1) <= 0.5 ? 'injured' : 'base';
}

// Swaps portrait art when the encounter or its state (base/injured/enraged/defeat) changes.
export function setBossPortrait(encounterId, state) {
    if (encounterId === currentEncounterId && state === currentState) return;
    currentEncounterId = encounterId;
    currentState = state;
    portraitImg.style.display = 'none';
    portraitImg.src = `img/${encounterId}${STATE_SUFFIX[state] || ''}.png`;
}

const DIALOGUE_DISPLAY_MS = 5000;

// intensity ramps 0 (calm) through 6 (total meltdown) — see the .boss-line-N
// styles in index.html for what each level actually looks like.
export function showBossLine(text, intensity = 0) {
    textEl.textContent = text;
    textEl.className = `boss-line-${Math.max(0, Math.min(6, intensity))}`;
    // Force a reflow so back-to-back lines at the same intensity restart
    // their shake/flicker animation instead of continuing mid-cycle.
    void textEl.offsetWidth;
    bubbleEl.classList.add('visible');

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubbleEl.classList.remove('visible'), DIALOGUE_DISPLAY_MS);
}
