// Host controls added for mid-fight pause and "restart with a different
// boss": only the host can toggle either, pausing freezes the boss/players/
// damage in place, and restarting mid-fight (not just after victory) can
// swap in a new encounter and un-pauses automatically.
const { check, finish, makeClient, sleep } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
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

  // Non-host cannot pause
  friend.send({ type: 'togglePause' });
  await sleep(250);
  check(host.lastState().paused === false, 'non-host togglePause is ignored');

  // Host pauses: state broadcasts keep flowing but say paused: true
  host.send({ type: 'togglePause' });
  await sleep(250);
  check(host.lastState().paused === true, 'host pause is reflected in state broadcasts');

  // Movement is frozen: reported positions are ignored while paused
  const beforeMove = host.me();
  host.send({ type: 'movementUpdate', keys: { ArrowRight: true }, x: beforeMove.x + 200, y: beforeMove.y });
  await sleep(250);
  const afterMove = host.me();
  check(afterMove.x === beforeMove.x, `movement ignored while paused (${beforeMove.x} -> ${afterMove.x})`);

  // Damage reports are frozen too
  const bossHpBefore = host.lastState().boss.hp;
  host.send({ type: 'bossDamage' });
  await sleep(150);
  check(host.lastState().boss.hp === bossHpBefore, 'boss damage ignored while paused');

  // Resume: toggling again brings it back and damage lands
  host.send({ type: 'togglePause' });
  await sleep(150);
  check(host.lastState().paused === false, 'pause toggles back off');
  host.send({ type: 'bossDamage' });
  await sleep(150);
  check(host.lastState().boss.hp === bossHpBefore - 10, 'damage lands again after resuming');

  // Mid-fight restart with a different boss: allowed even though phase !== 4,
  // and the new encounter config is broadcast to everyone.
  const encounterPromise = friend.waitForNext('encounterChanged');
  host.send({ type: 'restartGame', encounterId: 'helix' });
  const encounterMsg = await encounterPromise;
  check(encounterMsg.encounter.id === 'helix', `mid-fight restart swapped encounter to helix (got ${encounterMsg.encounter.id})`);

  await sleep(250);
  const s = host.lastState();
  check(s.phase === 1, `mid-fight restart reset phase to 1 (was ${s.phase})`);
  // Two players in this lobby: boss HP scales linearly with headcount.
  check(s.boss.maxHp === 4000, `boss HP now matches the new encounter (helix=2000 x2 players=4000, got ${s.boss.maxHp})`);
  check(s.paused === false, 'restart un-pauses the lobby');

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
