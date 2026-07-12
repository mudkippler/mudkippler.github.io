// The client is authoritative for its own position: movementUpdate carries
// the client's predicted x/y and the server adopts it verbatim (after a
// speed sanity check). This is what guarantees the player's ship NEVER moves
// on their own screen after all movement keys are released — the old
// "reconciliation drift" came from the server correcting the client toward
// its own slightly-lagged simulation.
const { check, finish, makeClient, sleep } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'blitz' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;
  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  const start = (await host.waitFor('state')).players.find(p => p.id === host.id);

  // Simulate what public/client.js does: predict movement locally at
  // 150px/s and report the predicted position alongside keys every 100ms.
  let x = start.x, y = start.y;
  for (let i = 0; i < 5; i++) {
    x = Math.round((x + 15) * 10) / 10; // 150px/s * 0.1s
    host.send({ type: 'movementUpdate', keys: { ArrowRight: true }, x, y });
    await sleep(100);
  }
  // Key released: final report with keys off at the predicted stop position.
  host.send({ type: 'movementUpdate', keys: { ArrowRight: false }, x, y });
  await sleep(200);

  // The server must have adopted the exact reported stop position, so the
  // client has nothing to reconcile...
  const stopped = host.me();
  check(
    Math.abs(stopped.x - x) < 0.11 && Math.abs(stopped.y - y) < 0.11,
    `server adopted reported stop position (server ${stopped.x},${stopped.y} vs reported ${x},${y})`
  );

  // ...and it must not move AT ALL afterwards, even while idle reports keep
  // arriving (the 100ms keepalive in the real client).
  for (let i = 0; i < 5; i++) {
    host.send({ type: 'movementUpdate', keys: { ArrowRight: false }, x, y });
    await sleep(100);
  }
  const later = host.me();
  check(
    later.x === stopped.x && later.y === stopped.y,
    `position unchanged 500ms after keys released (${stopped.x},${stopped.y} -> ${later.x},${later.y})`
  );

  // A teleport-sized report is rejected: the server keeps the last good
  // position instead of letting a hacked client jump across the arena.
  host.send({ type: 'movementUpdate', keys: {}, x: x + 300, y });
  await sleep(200);
  const afterCheat = host.me();
  check(
    Math.abs(afterCheat.x - stopped.x) < 0.11,
    `teleport-sized report rejected (still at x=${afterCheat.x}, cheat reported x=${x + 300})`
  );

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
