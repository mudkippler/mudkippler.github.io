import { WebSocket } from 'ws';
import msgpack from '@ygoe/msgpack';
// Default to the scaled-down fight HP/timers (see encounters.js) even when a
// suite is run directly (node test/foo.test.js) instead of through run.js,
// which sets this explicitly for the server subprocess too. Must be set
// before requiring encounters.js, which reads it at module load.
if (process.env.FAST_TESTS === undefined) process.env.FAST_TESTS = '1';
import { ENCOUNTERS } from '../server/encounters.js';

const PORT = process.env.TEST_PORT || 3100;
const URL = `ws://localhost:${PORT}`;

let failures = 0;

export function check(cond, label) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
  if (!cond) failures++;
  return cond;
}

export function finish() {
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

export function makeClient(name) {
  const ws = new WebSocket(URL);
  // bytesReceived mirrors what the in-game diagnostics panel measures on the
  // receive side — the bandwidth test samples it over a window.
  const client = { ws, name, messages: [], id: null, bytesReceived: 0 };
  ws.on('message', (buf) => {
    client.bytesReceived += buf.length;
    client.messages.push(msgpack.deserialize(new Uint8Array(buf)));
  });
  client.send = (m) => ws.send(msgpack.serialize(m));
  client.open = new Promise(res => ws.on('open', res));
  client.waitFor = (type, timeout = 4000) => new Promise((res, rej) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const m = client.messages.find(m => m.type === type);
      if (m) { clearInterval(poll); res(m); }
      else if (Date.now() - start > timeout) { clearInterval(poll); rej(new Error(`${name}: timeout waiting for ${type}`)); }
    }, 20);
  });
  // Like waitFor, but only considers messages that arrive after this call —
  // use for periodic broadcasts (e.g. the leaderboard's 1s timer) where a
  // stale message already sitting in `messages` would give a false match.
  client.waitForNext = (type, timeout = 4000) => new Promise((res, rej) => {
    const startLen = client.messages.length;
    const start = Date.now();
    const poll = setInterval(() => {
      const m = client.messages.slice(startLen).find(m => m.type === type);
      if (m) { clearInterval(poll); res(m); }
      else if (Date.now() - start > timeout) { clearInterval(poll); rej(new Error(`${name}: timeout waiting for next ${type}`)); }
    }, 20);
  });
  client.lastState = () => [...client.messages].reverse().find(m => m.type === 'state');
  client.me = () => {
    const s = client.lastState();
    return s && s.players.find(p => p.id === client.id);
  };
  client.find = (id) => {
    const s = client.lastState();
    return s && s.players.find(p => p.id === id);
  };
  return client;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// The wire's `phase` field is an index into the encounter's phase list —
// resolve it from the phase's stable id so assertions read as intent
// ('enrage', 'defeated') instead of magic numbers that shift when a fight
// gains a phase.
export function phaseIndex(encounterId, phaseId) {
  const index = ENCOUNTERS[encounterId].phases.findIndex(p => p.id === phaseId);
  if (index === -1) throw new Error(`encounter ${encounterId} has no phase '${phaseId}'`);
  return index;
}

// A phase's boss/orb HP pool scales linearly with headcount (see
// playerCount in server/phases.js) on top of whatever FAST_TESTS scaling
// encounters.js already applied — reading it from ENCOUNTERS instead of
// hardcoding the expected number keeps assertions correct under either mode.
export function phaseHp(encounterId, phaseId, playerCount, field = 'bossHp') {
  const phase = ENCOUNTERS[encounterId].phases.find(p => p.id === phaseId);
  if (!phase || phase[field] == null) throw new Error(`encounter ${encounterId} phase '${phaseId}' has no ${field}`);
  return phase[field] * playerCount;
}

// Non-HP phase knobs (e.g. convergeMs) that FAST_TESTS may also scale, but
// which don't scale with headcount the way bossHp/orbHp do — read the raw
// value instead of hardcoding it so timing-based sleeps stay correct either way.
export function phaseField(encounterId, phaseId, field) {
  const phase = ENCOUNTERS[encounterId].phases.find(p => p.id === phaseId);
  if (!phase || phase[field] == null) throw new Error(`encounter ${encounterId} phase '${phaseId}' has no ${field}`);
  return phase[field];
}

// Kill a player by reporting playerDamage 10 times (100 HP / 10 dmg), spaced
// past the server's 50ms anti-spam window.
export async function kill(client) {
  for (let i = 0; i < 10; i++) {
    client.send({ type: 'playerDamage' });
    await sleep(80);
  }
}

// Drive `mover` toward `targetId`'s body via movement keys until within
// close range, then hold still until `until()` is true.
export async function standOn(mover, targetId, until, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const me = mover.me();
    const target = mover.find(targetId);
    if (me && target) {
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      if (until()) { mover.send({ type: 'movementUpdate', keys: { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false } }); return true; }
      const close = Math.hypot(dx, dy) < 10;
      mover.send({
        type: 'movementUpdate',
        keys: {
          ArrowLeft: !close && dx < -5, ArrowRight: !close && dx > 5,
          ArrowUp: !close && dy < -5, ArrowDown: !close && dy > 5
        }
      });
    }
    await sleep(80);
  }
  return false;
}

