import { draw, triggerScreenExplosion } from './renderer.js';
import { updateHUD } from './hud.js';
import { updateLeaderboard } from './leaderboard.js';
import { updateBossBar, getFlairColor, applyBackgroundTheme } from './bossbar.js';
import { showBossDialogue, setBossPortrait, showBossLine, bossPortraitState } from './bossportrait.js';
import { updateDiagnostics, addReceivedBytes, addSentBytes } from './diagnostics.js';
import { MISSILE_EXPLOSION_DURATION, MISSILE_DAMAGE, LIGHTNING_STRIKE_MS, LIGHTNING_WIDTH, LIGHTNING_DAMAGE, isBlockedByStormUmbrella } from './attacks.js';
import { MECHANICS, activeMechanics } from './mechanics.js';

const INTERPOLATION_DELAY = 50; // milliseconds

const USE_MSGPACK_COMPRESSION = true; // Must match server setting

let serializer, deserializer;

if (USE_MSGPACK_COMPRESSION) {
    serializer = msgpack.serialize;
    deserializer = msgpack.deserialize;
} else {
    serializer = JSON.stringify;
    deserializer = JSON.parse;
}

let socket;

// This client simulates its own bullets and boss attacks locally (side-by-side
// co-op, not a fully synced multiplayer sim). The server only tells us other
// players' positions/health and the shared boss health. When our local
// simulation lands a hit, we report it to the server so boss HP / our health
// stays authoritative and shared.
const PLAYER_RADIUS = 10;
const PLAYER_BULLET_SPEED = 5;
const PLAYER_SHOT_COOLDOWN = 200; // ms
const PLAYER_SPEED_PER_SEC = 150; // matches the server's dt-scaled movement speed
const ORB_RADIUS = 18; // collision/render size for the orb-phase orbs
const ALLY_ALPHA = 0.75; // ally bullets/damage numbers render slightly faded

// The client is authoritative for its own position: movementUpdate reports
// our predicted position and the server adopts it (with a speed sanity
// check), so there is no continuous reconciliation that could nudge the ship
// when we aren't pressing anything. The one exception is a server-side
// teleport (encounter reset moving everyone back to spawn): if the server's
// copy is discontinuously far from our prediction, snap to it.
const RECONCILE_SNAP = 80; // px

// Fallback encounter shape until the server's config lands on join. Each
// encounter is an ordered list of phases (see server/encounters.js for the
// full field reference); the phase's `mechanic`/`params` drive the local
// attack simulation and its flags drive the UI.
const DEFAULT_ENCOUNTER = {
    id: 'twin', name: 'The Twin Guardian',
    phases: [{ id: 'main', bossDamageable: true, mechanic: 'ring', params: { attackRate: 100, numberOfAngles: 4, bulletSpeed: 1 } }]
};

let myId = null;
let myName = 'anon';
let lobbyCode = null;
let isHost = false;
let inGame = false; // true once the host has started the encounter
let encounter = DEFAULT_ENCOUNTER;
let isDead = false;
let paused = false; // host-toggled; freezes movement/combat, server still broadcasts state
let players = {};
let boss = {};
let phaseIndex = 0; // index into encounter.phases (authoritative from server)
let orbs = [];

// The active phase's definition — what's damageable, which mechanic runs,
// what the boss bar/portrait should show. Everything that used to key off a
// magic phase number reads a field from this instead.
function phaseDef() {
    const defs = encounter.phases || [];
    return defs[phaseIndex] || defs[0] || {};
}
let fullDamageLog = {};
const damagePopups = [];

// A message queued to be sent as soon as the socket opens (create/join lobby).
let pendingMessage = null;

// Grave markers are shared/persistent across the whole game, not per-life
// state, so they live outside resetLocalState() and survive respawns.
let graves = [];

// Locally-predicted position for our own player, so movement feels instant
// instead of waiting on the server round-trip. There's no gameplay
// consequence to this drifting slightly from the server's copy, since all
// collision is resolved client-side anyway.
let myPos = null;

let bullets = []; // local player bullets
let allyBullets = []; // teammates' bullets, spawned from relayed shot origins
let bossBullets = []; // local boss bullets
let bossMissiles = []; // local bombardment telegraphs/explosions — timed hazards, not moving projectiles
let bossLightning = []; // local storm lightning telegraphs/strikes — timed hazards, same idea as bossMissiles
let bulletIdCounter = 0;
let lastShot = 0;

// Scratch state for the active boss mechanics (attack cadence, ring rotation,
// bombardment's difficulty ratchet — see mechanics.js). Each mechanic's
// scratch lives under its own name so simultaneous mechanics don't trample
// each other's timers; cross-mechanic keys (the zone damage tick immunity)
// sit at the root as the `shared` scratch. Deliberately kept across phase
// transitions so timers/ratchets carry from the main fight into the enrage
// chase; reset when the encounter changes or resets.
let mechState = {};

function mechScratch(name) {
    return mechState[name] || (mechState[name] = {});
}

// Storm's current wind push, in px/sec — server-authoritative (see the
// 'state' handler) so every client's local prediction agrees on the same
// gusts instead of drifting apart with independently-computed randomness.
let wind = { x: 0, y: 0 };

// Per-tick mechanic values some phases broadcast (twin's ray angle / moon
// position / eclipse fraction) — server-authoritative for the same reason as
// wind: zone geometry has to agree across every client. Null outside those
// phases.
let mech = null;

// Stars seeded by the server during twin's moon phase, stamped with their
// local arrival time; the starfield mechanic drives their twinkle →
// explosion → light-pool lifecycle from that timestamp.
let bossStars = [];

// Solar flares seeded by the server during twin's sun phase — same idea as
// stars: the wedge geometry (angle/width/spin) rides in the event so every
// client agrees on it, the telegraph → burn timeline runs off local arrival.
let bossFlares = [];

// Bombardment's launchCodes phase: one maze per player, broadcast once on
// phase entry (see the 'mazeLayout' handler below) rather than per-tick like
// wind/mech — the layout is fixed for the whole phase, only the countdown
// (mech.mazeTimeLeft) changes tick to tick.
let mazeLayout = null;

const movementKeys = {}; // Store current state of movement keys

function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const payload = serializer(message);
    socket.send(USE_MSGPACK_COMPRESSION ? payload.buffer : payload);
    addSentBytes(USE_MSGPACK_COMPRESSION ? payload.byteLength : payload.length);
}

// --- Menu / lobby UI ------------------------------------------------------

const menuEl = document.getElementById('menu');
const lobbyScreenEl = document.getElementById('lobby-screen');
const menuErrorEl = document.getElementById('menu-error');
const playerNameInput = document.getElementById('player-name');
const joinCodeInput = document.getElementById('join-code');

// Mouse position in canvas space, used to aim the local player's shots.
// Defaults to straight up until the mouse first moves over the canvas.
const canvasEl = document.getElementById('game');
let mouseX = 400, mouseY = 0;
canvasEl.addEventListener('mousemove', e => {
    const rect = canvasEl.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (canvasEl.width / rect.width);
    mouseY = (e.clientY - rect.top) * (canvasEl.height / rect.height);
});

function inviteLink(code) {
    return `${location.origin}${location.pathname}?lobby=${code}`;
}

function showMenu(error) {
    menuEl.style.display = 'block';
    lobbyScreenEl.style.display = 'none';
    menuErrorEl.textContent = error || '';
}

function showLobbyScreen() {
    menuEl.style.display = 'none';
    lobbyScreenEl.style.display = 'block';
    document.getElementById('lobby-code-display').textContent = lobbyCode;
    document.getElementById('invite-link').value = inviteLink(lobbyCode);
    document.getElementById('start-btn').style.display = isHost ? 'block' : 'none';
    document.getElementById('waiting-msg').style.display = isHost ? 'none' : 'block';
}

function hideOverlays() {
    menuEl.style.display = 'none';
    lobbyScreenEl.style.display = 'none';
}

function updateLobbyPlayerList(lobbyPlayers, hostId) {
    const listEl = document.getElementById('lobby-players');
    listEl.innerHTML = '';
    for (const p of lobbyPlayers) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'player-dot';
        dot.style.background = p.color;
        li.appendChild(dot);
        li.appendChild(document.createTextNode(p.name + (p.id === hostId ? ' (host)' : '') + (p.id === myId ? ' — you' : '')));
        listEl.appendChild(li);
    }
    document.getElementById('lobby-encounter').textContent = encounter.name;
}

function connectAndSend(message) {
    pendingMessage = message;
    if (socket && socket.readyState === WebSocket.OPEN) {
        send(pendingMessage);
        pendingMessage = null;
    } else if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        connect();
    }
    // If CONNECTING, the open handler will flush pendingMessage.
}

document.getElementById('create-btn').addEventListener('click', () => {
    myName = playerNameInput.value.trim() || 'anon';
    const encounterId = document.getElementById('encounter-select').value;
    menuErrorEl.textContent = '';
    connectAndSend({ type: 'createLobby', name: myName, encounter: encounterId });
});

function attemptJoinLobby(code) {
    if (!code) {
        menuErrorEl.textContent = 'Enter a lobby code.';
        return;
    }
    myName = playerNameInput.value.trim() || 'anon';
    menuErrorEl.textContent = '';
    connectAndSend({ type: 'joinLobby', code, name: myName });
}

document.getElementById('join-btn').addEventListener('click', () => {
    attemptJoinLobby(joinCodeInput.value.trim().toUpperCase());
});

document.getElementById('start-btn').addEventListener('click', () => {
    send({ type: 'startGame' });
});

document.getElementById('restart-btn').addEventListener('click', () => {
    send({ type: 'restartGame' });
});

document.getElementById('pause-btn').addEventListener('click', () => {
    send({ type: 'togglePause' });
});

document.getElementById('change-boss-btn').addEventListener('click', () => {
    const encounterId = document.getElementById('change-encounter-select').value;
    send({ type: 'restartGame', encounterId });
});

// Visible only to the host, only once the fight is underway.
function updateHostControls() {
    document.getElementById('host-controls').style.display = (inGame && isHost) ? 'flex' : 'none';
    document.getElementById('change-encounter-select').value = encounter.id;
}

function updatePauseUI() {
    const btn = document.getElementById('pause-btn');
    btn.textContent = paused ? 'Resume' : 'Pause';
    btn.classList.toggle('active', paused);
    document.getElementById('pause-banner').style.display = paused ? 'block' : 'none';
}

document.getElementById('copy-link-btn').addEventListener('click', () => {
    const link = document.getElementById('invite-link');
    const btn = document.getElementById('copy-link-btn');

    const showCopied = () => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    };

    // navigator.clipboard requires a secure context and can silently reject
    // (e.g. plain-HTTP deployments), which used to leave the clipboard holding
    // whatever was copied there before — pasting a stale/unrelated link instead
    // of this lobby's. Fall back to the older execCommand path in that case.
    const legacyCopy = () => {
        link.select();
        document.execCommand('copy');
        showCopied();
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link.value).then(showCopied, legacyCopy);
    } else {
        legacyCopy();
    }
});

// Don't let typing in menu inputs drive the ship
for (const input of [playerNameInput, joinCodeInput]) {
    input.addEventListener('keydown', e => e.stopPropagation());
}

// --- Connection -----------------------------------------------------------

function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

    socket.addEventListener('open', () => {
        if (pendingMessage) {
            send(pendingMessage);
            pendingMessage = null;
        }
    });

    socket.addEventListener('message', async e => {
        let data;
        if (USE_MSGPACK_COMPRESSION) {
            data = deserializer(new Uint8Array(await e.data.arrayBuffer()));
            addReceivedBytes(e.data.size);
        } else {
            data = deserializer(e.data);
            addReceivedBytes(e.data.length);
        }

        if (data.type === 'joined') {
            myId = data.id;
            lobbyCode = data.code;
            isHost = data.hostId === myId;
            encounter = data.encounter;
            boss = data.boss;
            graves = data.graves || [];
            phaseIndex = data.phase || 0;
            orbs = data.orbs || [];
            inGame = data.started;
            paused = data.paused || false;
            setBossPortrait(encounter.id, bossPortraitState(phaseDef(), boss.hp, boss.maxHp));
            applyBackgroundTheme(encounter.id);

            // Make the current URL shareable/refreshable
            history.replaceState(null, '', inviteLink(lobbyCode));

            if (inGame) {
                hideOverlays();
            } else {
                showLobbyScreen();
            }
            updateHostControls();
            updatePauseUI();
            return;
        }

        if (data.type === 'lobbyError') {
            showMenu(data.message);
            inGame = false;
            lobbyCode = null;
            return;
        }

        if (data.type === 'lobbyState') {
            isHost = data.hostId === myId;
            encounter = { ...encounter, ...data.encounter };
            updateLobbyPlayerList(data.players, data.hostId);
            if (!inGame) showLobbyScreen(); // refresh host controls if host changed
            updateHostControls();
            return;
        }

        if (data.type === 'gameStart') {
            inGame = true;
            hideOverlays();
            updateHostControls();
            return;
        }

        if (data.type === 'encounterChanged') {
            // Host restarted with a (possibly different) boss mid-fight: swap
            // in the new attack config and drop anything from the old fight
            // that's purely client-local (the server's own state resets ride
            // in on the next 'state' broadcast).
            encounter = data.encounter;
            bullets = [];
            allyBullets = [];
            bossBullets = [];
            bossMissiles = [];
            bossLightning = [];
            bossStars = [];
            bossFlares = [];
            mazeLayout = null;
            mechState = {};
            setBossPortrait(encounter.id, 'base');
            applyBackgroundTheme(encounter.id);
            updateHostControls();
            return;
        }

        if (data.type === 'state') {
            const now = performance.now();

            // Update players object with interpolation history
            const newPlayers = {};
            for (const p of data.players) {
                const existingPlayer = players[p.id] || {};
                const newPlayer = { ...existingPlayer, ...p, history: existingPlayer.history || [] };

                newPlayer.history.push({ x: p.x, y: p.y, timestamp: now });
                newPlayer.history = newPlayer.history.filter(s => now - s.timestamp < 200);
                newPlayers[p.id] = newPlayer;
            }
            players = newPlayers;

            // Fallback revive detection: a team wipe resets the encounter and
            // brings everyone back without a per-player 'revived' message.
            if (isDead && players[myId] && !players[myId].dead) {
                isDead = false;
                myPos = null; // re-snap prediction to the server's respawn position
                document.getElementById('death-screen').style.display = 'none';
            }

            // The server adopts our reported position, so no continuous
            // reconciliation is needed — our ship only ever moves from our own
            // inputs. The single exception: a discontinuously large gap means
            // the server teleported us (encounter reset to spawn), so snap.
            if (myPos && players[myId]) {
                const server = players[myId];
                if (Math.hypot(server.x - myPos.x, server.y - myPos.y) > RECONCILE_SNAP) {
                    myPos.x = server.x;
                    myPos.y = server.y;
                }
            }

            boss = { ...boss, ...data.boss };
            wind = data.wind || { x: 0, y: 0, umbrella: true };
            mech = data.mech || null;
            const newPhaseIndex = data.phase || 0;
            // Leftover stars/flares don't outlive the phase that seeded them.
            if (newPhaseIndex !== phaseIndex) {
                bossStars = [];
                bossFlares = [];
            }
            // Host restarted after victory: the server teleported everyone
            // back to spawn, so drop our prediction and re-snap to it.
            if (phaseDef().victory && newPhaseIndex === 0) myPos = null;
            // Entering launchCodes: the server just teleported everyone to
            // their maze's start, discontinuously far from wherever we were
            // predicting — re-snap instead of drifting/walking there.
            if (newPhaseIndex !== phaseIndex && (encounter.phases[newPhaseIndex] || {}).mechanic === 'maze') {
                myPos = null;
            }
            // Any transition back to the opening phase means the encounter
            // was reset (mid-fight restart, post-victory restart, or an
            // automatic team wipe) — mechanic scratch state like
            // bombardment's earned difficulty ratchet shouldn't carry over
            // into a fresh fight.
            if (phaseIndex !== 0 && newPhaseIndex === 0) mechState = {};
            phaseIndex = newPhaseIndex;
            setBossPortrait(encounter.id, bossPortraitState(phaseDef(), boss.hp, boss.maxHp));
            orbs = data.orbs || [];
            const victorious = !!phaseDef().victory;
            document.getElementById('victory-banner').style.display = victorious ? 'block' : 'none';
            document.getElementById('restart-btn').style.display = victorious && isHost ? 'inline-block' : 'none';
            document.getElementById('victory-waiting').style.display = victorious && !isHost ? 'block' : 'none';

            if (data.paused !== undefined && data.paused !== paused) {
                paused = data.paused;
                updatePauseUI();
            }
            return;
        }

        if (data.type === 'leaderboard') {
            fullDamageLog = data.damageLog;
            return;
        }

        if (data.type === 'dead') {
            // Death is permanent for this run: spectate until a teammate
            // revives you (or the whole party wipes and the encounter resets).
            isDead = true;
            bullets = [];
            document.getElementById('death-screen').style.display = 'block';
            return;
        }

        if (data.type === 'revived') {
            isDead = false;
            myPos = null; // re-snap prediction to the server position (our body)
            document.getElementById('death-screen').style.display = 'none';
            return;
        }

        if (data.type === 'shot') {
            // A teammate fired: spawn their bullet locally from the relayed
            // origin, aimed the same direction they fired it.
            allyBullets.push({ x: data.x, y: data.y, dx: data.dx ?? 0, dy: data.dy ?? -PLAYER_BULLET_SPEED, color: data.color });
            return;
        }

        if (data.type === 'bossAimedShot') {
            // Phase-3 volley: each shot is aimed at where a player was standing
            // the instant it fired, not a continuously homing missile — moving
            // away from that spot before it arrives is enough to dodge.
            for (const target of data.targets) {
                const dx = target.x - data.origin.x;
                const dy = target.y - data.origin.y;
                const dist = Math.hypot(dx, dy) || 1;
                bossBullets.push({
                    x: data.origin.x,
                    y: data.origin.y,
                    dx: (dx / dist) * data.speed,
                    dy: (dy / dist) * data.speed,
                    type: 3,
                    size: 8
                });
            }
            return;
        }

        if (data.type === 'chat') {
            addChatMessage(data.color, data.name ? `${data.name}: ${data.text}` : data.text);
            return;
        }

        if (data.type === 'grave') {
            graves.push({ x: data.x, y: data.y, color: data.color });
            return;
        }

        if (data.type === 'mazeTimeout') {
            // Launch codes ran out with someone still inside their maze
            // (see the launchCodes timeout in server/phases.js) — the whole
            // party wipes together, so every screen erupts, not just the
            // laggards'.
            triggerScreenExplosion();
            return;
        }

        if (data.type === 'mazeLayout') {
            // One-off broadcast on phase entry (see launchCodes in
            // server/phases.js): every player's maze walls/start/exit,
            // fixed for the whole phase.
            mazeLayout = { timeLimit: data.timeLimit, mazes: data.mazes };
            return;
        }

        if (data.type === 'flare') {
            // A solar flare seeded by the server (twin's sun phase): its
            // telegraph → burn timeline runs off this local timestamp, same
            // as a star's twinkle → explosion.
            bossFlares.push({ ang: data.ang, w: data.w, len: data.len, spin: data.spin, spawn: performance.now() });
            return;
        }

        if (data.type === 'star') {
            // A star seeded by the server (twin's moon phase): its whole
            // twinkle/explosion/light timeline runs off this local timestamp.
            bossStars.push({ x: data.x, y: data.y, spawn: performance.now(), exploded: false });
            return;
        }

        if (data.type === 'bossSay') {
            // Boss speech reads as a chat line, colored to match this
            // encounter's flair so it's still visually distinct from players.
            addChatMessage(getFlairColor(encounter.id), `${encounter.name}: ${data.text}`, true);
            showBossLine(data.text, data.intensity || 0);
            return;
        }
    });
}

// On load: a shared ?lobby= link skips straight to "enter your name" for
// that lobby — no need to see the create-lobby options or re-type a code
// that's already known — and joins as soon as a name is submitted.
const urlLobbyCode = new URLSearchParams(location.search).get('lobby');
if (urlLobbyCode) {
    const code = urlLobbyCode.toUpperCase();
    joinCodeInput.value = code;
    document.getElementById('create-lobby-section').style.display = 'none';
    document.getElementById('join-code-field').style.display = 'none';
    document.getElementById('join-lobby-heading').textContent = `Join lobby ${code}`;
    playerNameInput.focus();
    playerNameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') attemptJoinLobby(code);
    });
}
showMenu();

function sendMovementUpdate() {
    if (inGame && socket && socket.readyState === WebSocket.OPEN) {
        // Report our predicted position — the server adopts it (after a speed
        // sanity check) so our ship's position is client-authoritative and
        // never needs correcting back on our own screen.
        const msg = (myPos && !isDead)
            ? { type: 'movementUpdate', keys: movementKeys, x: Math.round(myPos.x * 10) / 10, y: Math.round(myPos.y * 10) / 10 }
            : { type: 'movementUpdate', keys: movementKeys };
        send(msg);
    }
}

// Send movement keys state to server every 100ms as a keepalive/repair for
// dropped packets; key press/release changes are also pushed immediately
// (see the keydown/keyup handlers) so the server's copy of our movement
// trails our local prediction as little as possible.
// A single interval survives across respawns/reconnects since `socket` is
// re-pointed at the new connection by connect().
setInterval(sendMovementUpdate, 100);

const chatInput = document.getElementById('chat-input');
const chatMessagesEl = document.getElementById('chat-messages');
const CHAT_MAX_DISPLAYED = 50;

function addChatMessage(color, text, italic = false) {
    const line = document.createElement('div');
    line.style.color = color || 'white';
    if (italic) line.style.fontStyle = 'italic';
    line.textContent = text;
    chatMessagesEl.appendChild(line);
    while (chatMessagesEl.children.length > CHAT_MAX_DISPLAYED) {
        chatMessagesEl.removeChild(chatMessagesEl.firstChild);
    }
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

chatInput.addEventListener('keydown', e => {
    e.stopPropagation(); // don't let game key handling see this
    if (e.key === 'Enter') {
        const text = chatInput.value.trim();
        if (text) {
            send({ type: 'chat', text });
            chatInput.value = '';
        }
        chatInput.blur();
    } else if (e.key === 'Escape') {
        chatInput.blur();
    }
});

document.addEventListener('keydown', e => {
    if (document.activeElement === chatInput) return;

    const movementKeysMap = {
        'w': 'ArrowUp', 'a': 'ArrowLeft', 's': 'ArrowDown', 'd': 'ArrowRight',
        'ArrowUp': 'ArrowUp', 'ArrowLeft': 'ArrowLeft', 'ArrowDown': 'ArrowDown', 'ArrowRight': 'ArrowRight'
    };

    if (movementKeysMap[e.key]) {
        if (!movementKeys[movementKeysMap[e.key]]) {
            movementKeys[movementKeysMap[e.key]] = true;
            sendMovementUpdate(); // push key changes right away, don't wait for the interval
        }
    } else if (e.key === ' ' || e.code === 'Space') {
        movementKeys[' '] = true;
        if (inGame) e.preventDefault(); // don't scroll the page
    } else if (e.key === 'Enter') {
        if (inGame) chatInput.focus();
    }
});

document.addEventListener('keyup', e => {
    if (document.activeElement === chatInput) return;

    const movementKeysMap = {
        'w': 'ArrowUp', 'a': 'ArrowLeft', 's': 'ArrowDown', 'd': 'ArrowRight',
        'ArrowUp': 'ArrowUp', 'ArrowLeft': 'ArrowLeft', 'ArrowDown': 'ArrowDown', 'ArrowRight': 'ArrowRight'
    };

    if (movementKeysMap[e.key]) {
        if (movementKeys[movementKeysMap[e.key]]) {
            movementKeys[movementKeysMap[e.key]] = false;
            sendMovementUpdate(); // push key changes right away, don't wait for the interval
        }
    } else if (e.key === ' ' || e.code === 'Space') {
        movementKeys[' '] = false;
    }
});

// If the window/tab loses focus while a movement key is held (alt-tab,
// opening devtools, clicking another window), the browser never fires the
// matching keyup — the key stays "stuck" true, so the player keeps drifting
// in that direction (often horizontally, since a/d are the easiest to leave
// pressed) even once the player thinks they've let go. Clear everything on
// blur/hide and push the change immediately instead of waiting for the next
// 100ms movementUpdate tick.
function clearMovementKeys() {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']) {
        movementKeys[key] = false;
    }
    if (inGame && socket && socket.readyState === WebSocket.OPEN) {
        send({ type: 'movementUpdate', keys: movementKeys });
    }
}

window.addEventListener('blur', clearMovementKeys);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearMovementKeys();
});

function getInterpolatedPosition(entity, now) {
    let interpolatedX = entity.x;
    let interpolatedY = entity.y;

    if (!entity.history || entity.history.length < 2) {
        return { x: interpolatedX, y: interpolatedY };
    }

    // Find the two states to interpolate between
    let stateA = null;
    let stateB = null;
    for (let i = entity.history.length - 1; i >= 0; i--) {
        if (entity.history[i].timestamp <= now - INTERPOLATION_DELAY) {
            stateA = entity.history[i];
            if (i + 1 < entity.history.length) {
                stateB = entity.history[i + 1];
            }
            break;
        }
    }

    if (stateA && stateB) {
        const t = (now - INTERPOLATION_DELAY - stateA.timestamp) / (stateB.timestamp - stateA.timestamp);
        interpolatedX = stateA.x + (stateB.x - stateA.x) * t;
        interpolatedY = stateA.y + (stateB.y - stateA.y) * t;
    } else if (stateA) {
        // Not enough history to interpolate, use the most recent valid state
        interpolatedX = stateA.x;
        interpolatedY = stateA.y;
    }

    return { x: interpolatedX, y: interpolatedY };
}

function addDamagePopup(x, y, amount, color, alpha = 1) {
    damagePopups.push({ x, y, amount, color, alpha, dy: -0.5 });
}

// Ally bullets are cosmetic: the shooter reports the real damage, we just
// animate the bullet and pop a faded damage number when it visually connects.
// Runs even while we're dead so spectating still shows the fight.
function updateAllyBullets() {
    for (let i = allyBullets.length - 1; i >= 0; i--) {
        const b = allyBullets[i];
        b.x += b.dx;
        b.y += b.dy;

        let hit = false;
        if (phaseDef().bossDamageable) {
            hit = Math.hypot(b.x - boss.x, b.y - boss.y) < boss.radius;
        } else if (phaseDef().orbsDamageable) {
            hit = orbs.some(orb => orb.hp > 0 && Math.hypot(b.x - orb.x, b.y - orb.y) < ORB_RADIUS);
        }
        if (hit) {
            addDamagePopup(b.x, b.y, 10, b.color, ALLY_ALPHA);
        }

        if (hit || b.x < 0 || b.x > 800 || b.y < -20) {
            allyBullets.splice(i, 1);
        }
    }
}

// Whether storm's umbrella is currently standing on the field — it vanishes
// during a strong gust (wind.umbrella === false, see the gust calc in
// server.js), which the rain density (see the storm mechanic) also reacts to.
function stormUmbrellaActive() {
    return phaseDef().mechanic === 'storm' && wind.umbrella !== false;
}

function updateLocalCombat(now, myPos, alive) {
    // Fire local bullets (dead players can't shoot, but keep spectating)
    if (alive && myPos && (movementKeys[' '] || movementKeys['Space']) && now - lastShot > PLAYER_SHOT_COOLDOWN) {
        lastShot = now;

        // Aim at the mouse cursor; fall back to straight up if the cursor is
        // exactly on top of the player (zero-length direction).
        const aimDx = mouseX - myPos.x;
        const aimDy = mouseY - myPos.y;
        const aimDist = Math.hypot(aimDx, aimDy) || 1;
        const dx = (aimDx / aimDist) * PLAYER_BULLET_SPEED;
        const dy = (aimDy / aimDist) * PLAYER_BULLET_SPEED;

        bullets.push({
            id: bulletIdCounter++,
            x: myPos.x,
            y: myPos.y,
            dx,
            dy
        });
        // Tell teammates where the shot originated and its aim so they can render it
        send({ type: 'shot', x: myPos.x, y: myPos.y, dx, dy });
    }

    // Local boss attack simulation (cosmetic/local only, not synced across
    // clients). Runs regardless of `alive` so a dead/spectating player still
    // sees the fight play out. The active phase names which mechanic fires
    // (see mechanics.js) — an enrage chase phase typically reuses the main
    // fight's mechanic, just firing from wherever the roaming boss currently
    // is, with the server separately relaying aimed shots via 'bossAimedShot'.
    const def = phaseDef();
    // A phase may run several mechanics simultaneously (see activeMechanics
    // in mechanics.js) — each gets its own scratch keyed by name, plus the
    // shared root scratch for cross-mechanic state like the zone damage tick.
    for (const entry of activeMechanics(def)) {
        const mechanic = MECHANICS[entry.mechanic] || MECHANICS.ring;
        // boss.x is only undefined before the first join payload lands; hold
        // off spawning until then ('none' runs regardless since it only clears).
        if (boss.x === undefined && entry.mechanic !== 'none') continue;
        mechanic.update({
            now,
            state: mechScratch(entry.mechanic),
            shared: mechState,
            params: entry.params || {},
            boss,
            orbs,
            players: Object.values(players),
            wind,
            mech,
            stars: bossStars,
            flares: bossFlares,
            myPos,
            alive,
            send,
            addDamagePopup,
            bossBullets,
            bossMissiles,
            bossLightning
        });
    }

    // Update + collide player bullets against the current phase's target(s)
    const umbrellaOnField = stormUmbrellaActive();
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.dx;
        b.y += b.dy;

        if (umbrellaOnField && isBlockedByStormUmbrella(b.x, b.y)) {
            bullets.splice(i, 1); // your own shot can't pass through it either
            continue;
        }

        let hit = false;
        if (def.bossDamageable) {
            if (Math.hypot(b.x - boss.x, b.y - boss.y) < boss.radius) {
                addDamagePopup(b.x, b.y, 10, players[myId]?.color || 'white');
                send({ type: 'bossDamage' });
                hit = true;
            }
        } else if (def.orbsDamageable) {
            for (const orb of orbs) {
                if (orb.hp > 0 && Math.hypot(b.x - orb.x, b.y - orb.y) < ORB_RADIUS) {
                    addDamagePopup(b.x, b.y, 10, players[myId]?.color || 'white');
                    send({ type: 'orbDamage', orbId: orb.id });
                    hit = true;
                    break;
                }
            }
        }

        if (hit || b.x < 0 || b.x > 800 || b.y < 0 || b.y > 600) {
            bullets.splice(i, 1);
        }
    }

    // Update + collide boss bullets against the local player. Bullets keep
    // moving even while dead (so spectating looks right), they just pass
    // through a dead/invulnerable body instead of being consumed by it.
    for (let i = bossBullets.length - 1; i >= 0; i--) {
        const b = bossBullets[i];
        b.x += b.dx;
        b.y += b.dy;

        if (umbrellaOnField && isBlockedByStormUmbrella(b.x, b.y)) {
            bossBullets.splice(i, 1); // stopped cold by the canopy
            continue;
        }

        if (alive && myPos) {
            const dist = Math.hypot(b.x - myPos.x, b.y - myPos.y);
            if (dist < b.size + PLAYER_RADIUS - 5) {
                addDamagePopup(b.x, b.y, -10, 'red');
                bossBullets.splice(i, 1);
                send({ type: 'playerDamage' });
                continue;
            }
        }

        if (b.x < 0 || b.x > 800 || b.y < 0 || b.y > 600) {
            bossBullets.splice(i, 1);
        }
    }

    // Bombardment missiles: timed hazards rather than moving projectiles.
    // Each telegraphs its landing spot, then becomes a ring-shaped hitbox for
    // MISSILE_EXPLOSION_DURATION once its impact time arrives.
    for (let i = bossMissiles.length - 1; i >= 0; i--) {
        const m = bossMissiles[i];
        if (!m.exploded && now >= m.impactTime) {
            m.exploded = true;
            m.explodedAt = now;
        }

        if (m.exploded) {
            const elapsed = now - m.explodedAt;
            if (alive && myPos && !m.hit && elapsed < MISSILE_EXPLOSION_DURATION) {
                const dist = Math.hypot(myPos.x - m.x, myPos.y - m.y);
                if (dist < m.radius) {
                    m.hit = true; // one hit per explosion, not per frame it lingers
                    addDamagePopup(m.x, m.y, -MISSILE_DAMAGE, 'red');
                    send({ type: 'playerDamage', source: 'missile' });
                }
            }
            if (elapsed > MISSILE_EXPLOSION_DURATION) {
                bossMissiles.splice(i, 1);
            }
        }
    }

    // Storm lightning bolts: telegraph then a brief full-height strike hitbox
    // (a narrow vertical band, not a point) centered on the bolt's x.
    for (let i = bossLightning.length - 1; i >= 0; i--) {
        const bolt = bossLightning[i];
        if (!bolt.struck && now >= bolt.strikeTime) {
            bolt.struck = true;
        }

        if (bolt.struck) {
            const elapsed = now - bolt.strikeTime;
            if (alive && myPos && !bolt.hit && elapsed < LIGHTNING_STRIKE_MS && Math.abs(myPos.x - bolt.x) < LIGHTNING_WIDTH) {
                bolt.hit = true; // one hit per strike, not per frame it lingers
                addDamagePopup(bolt.x, myPos.y, -LIGHTNING_DAMAGE, 'red');
                send({ type: 'playerDamage', source: 'lightning' });
            }
            if (elapsed > LIGHTNING_STRIKE_MS) {
                bossLightning.splice(i, 1);
            }
        }
    }
}

function updateLocalMovement(dt) {
    if (!myPos) return;

    let vx = 0, vy = 0;
    if (movementKeys['ArrowUp']) vy -= 1;
    if (movementKeys['ArrowDown']) vy += 1;
    if (movementKeys['ArrowLeft']) vx -= 1;
    if (movementKeys['ArrowRight']) vx += 1;

    const len = Math.hypot(vx, vy);
    if (len > 0) {
        vx /= len;
        vy /= len;
    }

    myPos.x += vx * PLAYER_SPEED_PER_SEC * dt;
    myPos.y += vy * PLAYER_SPEED_PER_SEC * dt;

    // Storm's wind keeps pushing everyone around even while standing still.
    if (phaseDef().wind) {
        myPos.x += wind.x * dt;
        myPos.y += wind.y * dt;
    }

    myPos.x = Math.max(0, Math.min(800, myPos.x));
    myPos.y = Math.max(0, Math.min(600, myPos.y));
}

let lastFrameTime = performance.now();

function gameLoop() {
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // clamp spikes (e.g. tab backgrounded)
    lastFrameTime = now;

    // Snap local prediction to the server's spawn point the first time we see it
    if (!myPos && players[myId]) {
        myPos = { x: players[myId].x, y: players[myId].y };
    }
    if (inGame && !isDead && !paused) {
        updateLocalMovement(dt);
    }

    const interpolatedPlayers = Object.values(players).map(p => {
        if (p.id === myId && myPos) {
            return { ...p, x: myPos.x, y: myPos.y };
        }
        const { x, y } = getInterpolatedPosition(p, now);
        return { ...p, x, y };
    });

    const me = interpolatedPlayers.find(p => p.id === myId);
    if (inGame && !paused) {
        // Runs even while dead so the boss fight keeps animating for spectators;
        // the `alive` flag inside just gates shooting and taking damage.
        updateLocalCombat(now, me, !isDead);
        updateAllyBullets();
    }

    // Everything the renderer needs to draw the active mechanics' zones and
    // effects (sun rays, flares, darkness, stars, the eclipse) from the same
    // values the damage checks use — one entry per simultaneous mechanic.
    const mechView = {
        mechanics: activeMechanics(phaseDef()).map(m => ({
            name: m.mechanic,
            params: m.params || {},
            state: mechScratch(m.mechanic)
        })),
        mech,
        stars: bossStars,
        flares: bossFlares,
        maze: mazeLayout
    };

    draw(myId, interpolatedPlayers, bullets, allyBullets, bossBullets, bossMissiles, bossLightning, boss, damagePopups, graves, orbs, phaseDef(), stormUmbrellaActive(), mechView,
        encounter.id, bossPortraitState(phaseDef(), boss.hp, boss.maxHp));
    updateHUD(myId, Object.values(players));
    updateLeaderboard(myId, fullDamageLog);
    updateBossBar(encounter, boss, phaseDef(), inGame);
    showBossDialogue(inGame);
    updateDiagnostics();
    requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
