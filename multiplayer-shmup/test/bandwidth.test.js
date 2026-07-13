// Per-client bandwidth budget: a full lobby (10 players, the cap) in active
// combat must stay under 50 KB/s received — the same receive-side number the
// in-game diagnostics panel reports. Measured twice: in the twin's main
// phase (baseline state broadcasts + shot relays) and in the sun phase,
// whose per-tick mech broadcast (ray/glow/moon) is the heaviest state
// payload in the game.
const { check, finish, makeClient, sleep, phaseIndex } = require('./helpers');

const MAX_KBPS = 50;
const PLAYER_COUNT = 10; // must match the server's LOBBY_MAX_PLAYERS
const MEASURE_MS = 4000;

const ORBS = phaseIndex('twin', 'orbs');
const SUN = phaseIndex('twin', 'sun');

(async () => {
  const host = makeClient('p0');
  await host.open;
  host.send({ type: 'createLobby', name: 'Player0', encounter: 'twin' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;

  const clients = [host];
  for (let i = 1; i < PLAYER_COUNT; i++) {
    const c = makeClient(`p${i}`);
    await c.open;
    c.send({ type: 'joinLobby', code: joined.code, name: `Player${i}` });
    const j = await c.waitFor('joined');
    c.id = j.id;
    clients.push(c);
  }
  check(clients.length === PLAYER_COUNT, `all ${PLAYER_COUNT} players joined one lobby`);

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  await host.waitFor('state');

  // Full combat load on every client: movement updates, shot relays (each
  // fans out to the 9 teammates), and damage reports at the fastest cadence
  // the server accepts. During the orb phase the damage switches to the
  // orbs (split across clients) so the fight keeps advancing toward the sun.
  let combatActive = true;
  const combatLoops = clients.map(async (c, idx) => {
    let flip = false;
    while (combatActive) {
      c.send({ type: 'movementUpdate', keys: { ArrowLeft: flip, ArrowRight: !flip } });
      c.send({ type: 'shot', x: 400, y: 500, dx: 0, dy: -5 });
      const s = c.lastState();
      if (s && s.phase === ORBS) {
        c.send({ type: 'orbDamage', orbId: idx % 2 });
      } else {
        c.send({ type: 'bossDamage' });
      }
      flip = !flip;
      await sleep(60);
    }
  });

  async function measureReceiveRate(label) {
    const before = clients.map(c => c.bytesReceived);
    await sleep(MEASURE_MS);
    const kbps = clients.map((c, i) => (c.bytesReceived - before[i]) / (MEASURE_MS / 1000) / 1024);
    const worst = Math.max(...kbps);
    check(worst < MAX_KBPS, `${label}: worst client received ${worst.toFixed(1)} KB/s (budget ${MAX_KBPS} KB/s)`);
  }

  await measureReceiveRate(`main phase, ${PLAYER_COUNT} players in combat`);

  // The combat loops above are already chewing through the fight; wait for
  // the sun phase (25000 main HP at 10 players, then the orbs).
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const s = host.lastState();
    if (s && s.phase === SUN) break;
    await sleep(200);
  }
  check(host.lastState().phase === SUN, `fight advanced to the sun phase (phase ${host.lastState().phase})`);

  await measureReceiveRate(`sun phase (mech broadcast), ${PLAYER_COUNT} players in combat`);

  combatActive = false;
  await Promise.all(combatLoops);
  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
