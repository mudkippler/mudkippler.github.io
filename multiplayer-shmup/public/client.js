import { draw } from './renderer.js';
import { updateHUD } from './hud.js';
import { updateDiagnostics, addReceivedBytes, addSentBytes } from './diagnostics.js';
import { circularAttack, bigRedBallAttack } from './attacks.js';

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
const PLAYER_SPEED_PER_SEC = 150; // matches server's PLAYER_SPEED(10) * TICK_RATE(15)
const ORB_RADIUS = 18; // collision/render size for the phase-2 orbs
const ALLY_ALPHA = 0.75; // ally bullets/damage numbers render slightly faded
const BOSS_MESSAGE_DURATION = 4000; // ms boss speech stays on screen

// Fallback attack parameters; overwritten by the encounter config the server
// sends on join. Attack rate/pattern is what differentiates encounters.
const DEFAULT_ENCOUNTER = { id: 'twin', name: 'The Twin Guardian', attackRate: 100, numberOfAngles: 4, bulletSpeed: 1, bigRedChance: 0.1 };

let myId = null;
let myName = 'anon';
let lobbyCode = null;
let isHost = false;
let inGame = false; // true once the host has started the encounter
let encounter = DEFAULT_ENCOUNTER;
let isDead = false;
let players = {};
let boss = {};
let phase = 1; // 1: boss, 2: twin orbs, 3: defeated (authoritative from server)
let orbs = [];
let bossMessage = null; // {text, expiresAt} — latest boss speech line
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
let bulletIdCounter = 0;
let lastShot = 0;
let lastBossAttack = 0;
let bossAngleOffset = 0;

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

document.getElementById('join-btn').addEventListener('click', () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (!code) {
        menuErrorEl.textContent = 'Enter a lobby code.';
        return;
    }
    myName = playerNameInput.value.trim() || 'anon';
    menuErrorEl.textContent = '';
    connectAndSend({ type: 'joinLobby', code, name: myName });
});

document.getElementById('start-btn').addEventListener('click', () => {
    send({ type: 'startGame' });
});

document.getElementById('copy-link-btn').addEventListener('click', () => {
    const link = document.getElementById('invite-link');
    link.select();
    navigator.clipboard.writeText(link.value).then(() => {
        const btn = document.getElementById('copy-link-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
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
            phase = data.phase || 1;
            orbs = data.orbs || [];
            inGame = data.started;

            // Make the current URL shareable/refreshable
            history.replaceState(null, '', inviteLink(lobbyCode));

            if (inGame) {
                hideOverlays();
            } else {
                showLobbyScreen();
            }
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
            return;
        }

        if (data.type === 'gameStart') {
            inGame = true;
            hideOverlays();
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

            boss = { ...boss, ...data.boss };
            phase = data.phase || 1;
            orbs = data.orbs || [];
            document.getElementById('victory-banner').style.display = phase === 3 ? 'block' : 'none';
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
            // origin. Trajectory is implied — bullets travel straight up.
            allyBullets.push({ x: data.x, y: data.y, dx: 0, dy: -PLAYER_BULLET_SPEED, color: data.color });
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

        if (data.type === 'bossSay') {
            bossMessage = { text: data.text, expiresAt: performance.now() + BOSS_MESSAGE_DURATION };
            return;
        }
    });
}

// On load: show the menu, prefilling the lobby code from a shared ?lobby= link
const urlLobbyCode = new URLSearchParams(location.search).get('lobby');
if (urlLobbyCode) {
    joinCodeInput.value = urlLobbyCode.toUpperCase();
    playerNameInput.focus();
}
showMenu();

// Send movement keys state to server every 100ms (or server tick rate).
// A single interval survives across respawns/reconnects since `socket` is
// re-pointed at the new connection by connect().
setInterval(() => {
    if (inGame && socket && socket.readyState === WebSocket.OPEN) {
        send({ type: 'movementUpdate', keys: movementKeys });
    }
}, 100);

const chatInput = document.getElementById('chat-input');
const chatMessagesEl = document.getElementById('chat-messages');
const CHAT_MAX_DISPLAYED = 50;

function addChatMessage(color, text) {
    const line = document.createElement('div');
    line.style.color = color || 'white';
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
        movementKeys[movementKeysMap[e.key]] = true;
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
        movementKeys[movementKeysMap[e.key]] = false;
    } else if (e.key === ' ' || e.code === 'Space') {
        movementKeys[' '] = false;
    }
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
        if (phase === 1) {
            hit = Math.hypot(b.x - boss.x, b.y - boss.y) < boss.radius;
        } else if (phase === 2) {
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

function updateLocalCombat(now, myPos) {
    // Fire local bullets
    if (myPos && (movementKeys[' '] || movementKeys['Space']) && now - lastShot > PLAYER_SHOT_COOLDOWN) {
        lastShot = now;
        bullets.push({
            id: bulletIdCounter++,
            x: myPos.x,
            y: myPos.y,
            dx: 0,
            dy: -PLAYER_BULLET_SPEED
        });
        // Tell teammates where the shot originated so they can render it
        send({ type: 'shot', x: myPos.x, y: myPos.y });
    }

    // Local boss attack simulation (cosmetic/local only, not synced across
    // clients). Attack rate/pattern comes from the lobby's chosen encounter.
    if (phase === 3) {
        bossBullets.length = 0; // defeated boss stops shooting immediately
    } else if (phase === 2) {
        // The orbs take over the shooting during the co-op phase
        if (now - lastBossAttack > encounter.attackRate * 2) {
            lastBossAttack = now;
            for (const orb of orbs) {
                if (orb.hp > 0) circularAttack(orb, bossBullets, bossAngleOffset, encounter.numberOfAngles, encounter.bulletSpeed);
            }
            bossAngleOffset += 0.15;
        }
    } else if (boss.x !== undefined && now - lastBossAttack > encounter.attackRate) {
        lastBossAttack = now;
        circularAttack(boss, bossBullets, bossAngleOffset, encounter.numberOfAngles, encounter.bulletSpeed);
        bossAngleOffset += 0.1;
        if (Math.random() < encounter.bigRedChance) {
            bigRedBallAttack(boss, bossBullets);
        }
    }

    // Update + collide player bullets against the current phase's target(s)
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.dx;
        b.y += b.dy;

        let hit = false;
        if (phase === 1) {
            if (Math.hypot(b.x - boss.x, b.y - boss.y) < boss.radius) {
                addDamagePopup(b.x, b.y, 10, players[myId]?.color || 'white');
                send({ type: 'bossDamage' });
                hit = true;
            }
        } else if (phase === 2) {
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

    // Update + collide boss bullets against the local player
    for (let i = bossBullets.length - 1; i >= 0; i--) {
        const b = bossBullets[i];
        b.x += b.dx;
        b.y += b.dy;

        if (myPos) {
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
    if (inGame && !isDead) {
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
    if (inGame && !isDead) {
        updateLocalCombat(now, me);
    }
    if (inGame) {
        updateAllyBullets(); // runs even while dead, so spectating shows the fight
    }

    draw(myId, interpolatedPlayers, bullets, allyBullets, bossBullets, boss, fullDamageLog, damagePopups, graves, orbs, bossMessage);
    updateHUD(myId, Object.values(players));
    updateDiagnostics();
    requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
