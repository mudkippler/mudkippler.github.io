// Sanity check for the server's dt-scaled movement: a held key should move a
// player at PLAYER_SPEED_PER_SEC (150px/s) regardless of how fast the tick
// loop actually fires, not a fixed distance per tick. This guards against
// regressing to the old fixed-per-tick step, which drifted from the client's
// own real-time prediction under any tick jitter — the root cause of the
// position desync between players.
import { check, finish, makeClient, sleep } from './helpers.js';

(async () => {
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'blitz' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  const initial = (await host.waitFor('state')).players.find(p => p.id === host.id);

  const HOLD_MS = 1000;
  host.send({ type: 'movementUpdate', keys: { ArrowRight: true } });
  await sleep(HOLD_MS);
  host.send({ type: 'movementUpdate', keys: { ArrowRight: false } });
  await sleep(150); // let the stop command land

  const after = host.lastState().players.find(p => p.id === host.id);
  const displacement = after.x - initial.x;
  const expected = 150 * (HOLD_MS / 1000); // PLAYER_SPEED_PER_SEC

  // Generous tolerance: test-harness timer jitter (setTimeout, event loop,
  // network) affects how long the key was actually "held" server-side, but
  // the point under test is that displacement tracks wall-clock time, not
  // tick count — a fixed-per-tick regression would be off by a much larger,
  // load-dependent margin than this.
  check(
    Math.abs(displacement - expected) < 40,
    `held ArrowRight for ${HOLD_MS}ms moved ~${displacement.toFixed(1)}px (expected ~${expected}px)`
  );

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
