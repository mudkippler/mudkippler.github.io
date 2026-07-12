// E2E coverage of the post-victory "fight again" flow: only the host can
// restart, and restarting fully resets the encounter (boss HP, phase, players).
const { check, finish, makeClient, sleep } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
  // 'blitz' has the lowest HP of the encounters (1500 main + 300 chase), so
  // it's cheapest to fully defeat here.
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'blitz' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;

  const friend = makeClient('friend');
  await friend.open;
  friend.send({ type: 'joinLobby', code: joined.code, name: 'Bob' });
  const fJoined = await friend.waitFor('joined');
  friend.id = fJoined.id;

  host.send({ type: 'startGame' });
  await friend.waitFor('gameStart');
  await host.waitFor('state');

  // Defeat the boss all the way through: phase 1 (1500 HP) transitions into
  // phase 3's enrage chase (another 300 HP) before finally reaching phase 4.
  // bossDamage applies in both phase 1 and phase 3, so just keep firing.
  let sawChasePhase = false;
  for (let i = 0; i < 220; i++) {
    host.send({ type: 'bossDamage' });
    await sleep(55);
    const s = host.lastState();
    if (s && s.phase === 3) sawChasePhase = true;
    if (s && s.phase === 4) break;
  }
  const victoryState = host.lastState();
  check(sawChasePhase, 'boss passed through the phase-3 enrage chase before dying');
  check(victoryState.phase === 4, `boss fully defeated, phase is 4 (was ${victoryState.phase})`);

  // Non-host restart is ignored
  friend.send({ type: 'restartGame' });
  await sleep(300);
  let s = host.lastState();
  check(s.phase === 4, 'non-host restartGame is ignored, still phase 4');

  // Host restart resets the encounter
  host.send({ type: 'restartGame' });
  await sleep(300);
  s = host.lastState();
  check(s.phase === 1, `host restart resets phase back to 1 (was ${s.phase})`);
  check(s.boss.hp === s.boss.maxHp && s.boss.maxHp === 1500, `host restart resets boss to full main-phase HP (${s.boss.hp}/${s.boss.maxHp})`);
  check(s.players.every(p => !p.dead && p.health === 100), 'host restart brings every player back to full health');

  // Confirm the reset actually took (repeated damage works again since the
  // boss isn't defeated anymore). Restart itself is no longer gated to
  // phase 4 — see pause-and-restart.test.js for the mid-fight case.
  host.send({ type: 'bossDamage' });
  await sleep(200);
  s = host.lastState();
  check(s.boss.hp === 1490, `boss is damageable again after restart (hp=${s.boss.hp})`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
