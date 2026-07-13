// E2E coverage of the post-victory "fight again" flow: only the host can
// restart, and restarting fully resets the encounter (boss HP, phase, players).
const { check, finish, makeClient, sleep, phaseIndex } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
  // 'blitz' has the lowest HP of the encounters (1500 main + 300 chase), so
  // it's cheapest to fully defeat here. Two players join below, which
  // doubles both pools (boss HP scales linearly with headcount).
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

  // Defeat the boss all the way through: the main phase (3000 HP at 2
  // players) transitions into the enrage chase (another 600 HP) before
  // finally reaching the defeated phase. bossDamage applies in both the main
  // phase and the chase, so just keep firing.
  const ENRAGE = phaseIndex('blitz', 'enrage');
  const DEFEATED = phaseIndex('blitz', 'defeated');
  const MAIN = phaseIndex('blitz', 'main');
  let sawChasePhase = false;
  for (let i = 0; i < 400; i++) {
    host.send({ type: 'bossDamage' });
    await sleep(55);
    const s = host.lastState();
    if (s && s.phase === ENRAGE) sawChasePhase = true;
    if (s && s.phase === DEFEATED) break;
  }
  const victoryState = host.lastState();
  check(sawChasePhase, 'boss passed through the enrage chase before dying');
  check(victoryState.phase === DEFEATED, `boss fully defeated (phase was ${victoryState.phase})`);

  // Non-host restart is ignored
  friend.send({ type: 'restartGame' });
  await sleep(300);
  let s = host.lastState();
  check(s.phase === DEFEATED, 'non-host restartGame is ignored, still defeated');

  // Host restart resets the encounter
  host.send({ type: 'restartGame' });
  await sleep(300);
  s = host.lastState();
  check(s.phase === MAIN, `host restart resets back to the main phase (was ${s.phase})`);
  check(s.boss.hp === s.boss.maxHp && s.boss.maxHp === 3000, `host restart resets boss to full main-phase HP (${s.boss.hp}/${s.boss.maxHp})`);
  check(s.players.every(p => !p.dead && p.health === 100), 'host restart brings every player back to full health');

  // Confirm the reset actually took (repeated damage works again since the
  // boss isn't defeated anymore). Restart itself is not gated to the
  // defeated phase — see pause-and-restart.test.js for the mid-fight case.
  host.send({ type: 'bossDamage' });
  await sleep(200);
  s = host.lastState();
  check(s.boss.hp === 2990, `boss is damageable again after restart (hp=${s.boss.hp})`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
