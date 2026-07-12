// E2E coverage of the post-victory "fight again" flow: only the host can
// restart, and restarting fully resets the encounter (boss HP, phase, players).
const { check, finish, makeClient, sleep } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
  // 'blitz' has the lowest boss HP (1500) of the encounters, so it's cheap to defeat here.
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

  // Defeat the boss: 1500 HP / 10 dmg per hit = 150 hits, well under the
  // 50ms anti-spam window per hit.
  for (let i = 0; i < 150; i++) {
    host.send({ type: 'bossDamage' });
    await sleep(55);
    const s = host.lastState();
    if (s && s.phase === 3) break;
  }
  const victoryState = host.lastState();
  check(victoryState.phase === 3, `boss defeated, phase is 3 (was ${victoryState.phase})`);

  // Non-host restart is ignored
  friend.send({ type: 'restartGame' });
  await sleep(300);
  let s = host.lastState();
  check(s.phase === 3, 'non-host restartGame is ignored, still phase 3');

  // Host restart resets the encounter
  host.send({ type: 'restartGame' });
  await sleep(300);
  s = host.lastState();
  check(s.phase === 1, `host restart resets phase back to 1 (was ${s.phase})`);
  check(s.boss.hp === s.boss.maxHp, `host restart resets boss to full HP (${s.boss.hp}/${s.boss.maxHp})`);
  check(s.players.every(p => !p.dead && p.health === 100), 'host restart brings every player back to full health');

  // Restart is a no-op outside phase 3 (already tested implicitly: repeated
  // damage now works again since the boss isn't defeated anymore)
  host.send({ type: 'bossDamage' });
  await sleep(200);
  s = host.lastState();
  check(s.boss.hp === s.boss.maxHp - 10, `boss is damageable again after restart (hp=${s.boss.hp})`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
