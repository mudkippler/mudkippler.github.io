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
const BOSS_ATTACK_RATE = 100; // ms between boss attacks
const PLAYER_SPEED_PER_SEC = 150; // matches server's PLAYER_SPEED(10) * TICK_RATE(15)
const RESPAWN_DELAY = 1500; // ms
const ORB_RADIUS = 18; // collision/render size for the phase-2 orbs
const BOSS_MESSAGE_DURATION = 4000; // ms boss speech stays on screen

let myId = null;
let isDead = false;
let players = {};
let boss = {};
let phase = 1; // 1: boss, 2: twin orbs, 3: defeated (authoritative from server)
let orbs = [];
let bossMessage = null; // {text, expiresAt} — latest boss speech line
let fullDamageLog = {};
const damagePopups = [];

// Grave markers are shared/persistent across the whole game, not per-life
// state, so they live outside resetLocalState() and survive respawns.
let graves = [];

// Locally-predicted position for our own player, so movement feels instant
// instead of waiting on the server round-trip. There's no gameplay
// consequence to this drifting slightly from the server's copy, since all
// collision is resolved client-side anyway.
let myPos = null;

let bullets = []; // local player bullets
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

function resetLocalState() {
    myId = null;
    isDead = false;
    players = {};
    myPos = null;
    bullets = [];
    bossBullets = [];
    damagePopups.length = 0;
    lastShot = 0;
    lastBossAttack = 0;
    bossAngleOffset = 0;
}

let respawnCountdownInterval = null;

function startRespawnCountdown() {
    const countdownEl = document.getElementById('respawn-countdown');
    const deathTime = performance.now();

    const tick = () => {
        const remaining = Math.max(0, RESPAWN_DELAY - (performance.now() - deathTime));
        countdownEl.textContent = (remaining / 1000).toFixed(1);
        if (remaining <= 0) clearInterval(respawnCountdownInterval);
    };

    tick();
    respawnCountdownInterval = setInterval(tick, 100);
}

function respawn() {
    clearInterval(respawnCountdownInterval);
    document.getElementById('death-screen').style.display = 'none';
    resetLocalState();
    connect();
}

function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

    socket.addEventListener('message', async e => {
        let data;
        if (USE_MSGPACK_COMPRESSION) {
            data = deserializer(new Uint8Array(await e.data.arrayBuffer()));
            addReceivedBytes(e.data.size);
        } else {
            data = deserializer(e.data);
            addReceivedBytes(e.data.length);
        }

        if (data.type === 'init') {
            myId = data.id;
            boss = data.boss;
            graves = data.graves || [];
            phase = data.phase || 1;
            orbs = data.orbs || [];
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
            isDead = true;
            document.getElementById('death-screen').style.display = 'block';
            startRespawnCountdown();
            setTimeout(respawn, RESPAWN_DELAY);
            return;
        }

        if (data.type === 'chat') {
            addChatMessage(data.color, data.text);
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

connect();

// Send movement keys state to server every 100ms (or server tick rate).
// A single interval survives across respawns/reconnects since `socket` is
// re-pointed at the new connection by connect().
setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
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
        e.preventDefault(); // don't scroll the page
    } else if (e.key === 'Enter') {
        chatInput.focus();
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

function addDamagePopup(x, y, amount, color) {
    damagePopups.push({ x, y, amount, color, alpha: 1, dy: -0.5 });
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
    }

    // Local boss attack simulation (cosmetic/local only, not synced across clients)
    if (phase === 3) {
        bossBullets.length = 0; // defeated boss stops shooting immediately
    } else if (phase === 2) {
        // The orbs take over the shooting during the co-op phase
        if (now - lastBossAttack > BOSS_ATTACK_RATE * 2) {
            lastBossAttack = now;
            for (const orb of orbs) {
                if (orb.hp > 0) circularAttack(orb, bossBullets, bossAngleOffset);
            }
            bossAngleOffset += 0.15;
        }
    } else if (boss.x !== undefined && now - lastBossAttack > BOSS_ATTACK_RATE) {
        lastBossAttack = now;
        circularAttack(boss, bossBullets, bossAngleOffset);
        bossAngleOffset += 0.1;
        if (Math.random() < 0.1) {
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
    if (!isDead) {
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
    if (!isDead) {
        updateLocalCombat(now, me);
    }

    draw(myId, interpolatedPlayers, bullets, bossBullets, boss, fullDamageLog, damagePopups, graves, orbs, bossMessage);
    updateHUD(myId, Object.values(players));
    updateDiagnostics();
    requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
