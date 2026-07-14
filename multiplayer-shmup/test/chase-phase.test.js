// E2E coverage of the boss's "enrage chase" phase: entered either by
// depleting the main boss HP (no-orb encounters) or by clearing both twin
// orbs together, it gives the boss a fresh HP pool, makes it roam the arena,
// and has it periodically fire shots aimed at each living player's position.
const { check, finish, makeClient, sleep, kill, phaseIndex, phaseHp } = require('./helpers');

async function damageBossUntil(client, predicate, maxHits = 220) {
  for (let i = 0; i < maxHits; i++) {
    client.send({ type: 'bossDamage' });
    await sleep(55);
    const s = client.lastState();
    if (s && predicate(s)) return s;
  }
  return client.lastState();
}

(async () => {
  // --- Entry via main-phase depletion (no orb phase) ---
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'blitz' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  await host.waitFor('state');

  const BLITZ_ENRAGE = phaseIndex('blitz', 'enrage');
  const chaseState = await damageBossUntil(host, s => s.phase === BLITZ_ENRAGE);
  check(chaseState.phase === BLITZ_ENRAGE, `depleting main boss HP enters the enrage chase (phase was ${chaseState.phase})`);
  const blitzEnrageHp = phaseHp('blitz', 'enrage', 1);
  check(chaseState.boss.maxHp === blitzEnrageHp, `chase phase uses blitz's enrage HP pool (${blitzEnrageHp}), got ${chaseState.boss.maxHp}`);
  // Allow a little slack: the test's damage cadence can land another hit or
  // two before the client observes the enrage transition broadcast, same as
  // it would for any player attacking continuously through the transition.
  check(chaseState.boss.hp > chaseState.boss.maxHp - 30, `chase phase boss starts near full chase HP (${chaseState.boss.hp}/${chaseState.boss.maxHp})`);

  // Boss should still be damageable during the enrage chase
  const beforeHp = host.lastState().boss.hp;
  host.send({ type: 'bossDamage' });
  await sleep(200);
  check(host.lastState().boss.hp === beforeHp - 10, 'boss takes damage during the chase phase');

  // Boss should roam within the arena (sample position over ~1.5s of chase
  // movement — blitz's chaseSpeed is 110px/s so it should visibly move
  // unless unlucky enough to be sitting exactly on a waypoint each sample).
  const positions = [];
  for (let i = 0; i < 6; i++) {
    const s = host.lastState();
    if (s) positions.push({ x: s.boss.x, y: s.boss.y });
    await sleep(250);
  }
  const moved = positions.some(p => Math.hypot(p.x - positions[0].x, p.y - positions[0].y) > 15);
  check(moved, `boss position changes over time while roaming (samples: ${JSON.stringify(positions)})`);
  check(
    positions.every(p => p.x >= 50 && p.x <= 750 && p.y >= 60 && p.y <= 440),
    'boss stays within the chase arena bounds while roaming'
  );

  // Aimed shots: wait for a bossAimedShot broadcast and check it targets
  // (approximately) where the player actually was.
  const shot = await host.waitFor('bossAimedShot', 3000);
  check(Array.isArray(shot.targets) && shot.targets.length > 0, 'bossAimedShot includes at least one target');
  check(typeof shot.origin.x === 'number' && typeof shot.speed === 'number', 'bossAimedShot includes an origin and speed');
  const myPos = host.me();
  const target = shot.targets[0];
  check(
    Math.hypot(target.x - myPos.x, target.y - myPos.y) < 60,
    `aimed shot targets close to the player's actual position (target ${JSON.stringify(target)}, player ${JSON.stringify({ x: myPos.x, y: myPos.y })})`
  );

  // --- Twin orbs cleared together advance the fight (into the sun phase —
  // --- the full sun/moon/eclipse walk is covered in twin-guardians.test.js) ---
  const twinHost = makeClient('twinHost');
  await twinHost.open;
  twinHost.send({ type: 'createLobby', name: 'Carol', encounter: 'twin' });
  const twinJoined = await twinHost.waitFor('joined');
  twinHost.id = twinJoined.id;

  const twinFriend = makeClient('twinFriend');
  await twinFriend.open;
  twinFriend.send({ type: 'joinLobby', code: twinJoined.code, name: 'Dave' });
  await twinFriend.waitFor('joined');

  twinHost.send({ type: 'startGame' });
  await twinHost.waitFor('gameStart');
  await twinHost.waitFor('state');

  // Get through the main phase into the orb phase — twin has 5000 HP at two
  // players, so this needs a much higher hit cap than the default (sized for
  // blitz's 1500).
  const TWIN_ORBS = phaseIndex('twin', 'orbs');
  await damageBossUntil(twinHost, s => s.phase === TWIN_ORBS, 550);
  check(twinHost.lastState().phase === TWIN_ORBS, 'twin boss depletion enters the orb phase as before');

  // The kill-together window is only 3s — a single player can't clear both
  // orbs sequentially (by design, see server.js), so use two players hitting
  // different orbs concurrently. Hit count is derived from orbHp (rather than
  // a fixed guess) so it stays correct whether FAST_TESTS is scaling that
  // pool down or not.
  const orbHits = Math.ceil(phaseHp('twin', 'orbs', 1, 'orbHp') / 10) + 2;
  await Promise.all([
    (async () => { for (let i = 0; i < orbHits; i++) { twinHost.send({ type: 'orbDamage', orbId: 0 }); await sleep(55); } })(),
    (async () => { for (let i = 0; i < orbHits; i++) { twinFriend.send({ type: 'orbDamage', orbId: 1 }); await sleep(55); } })()
  ]);
  await sleep(300);
  const twinSunState = twinHost.lastState();
  check(twinSunState.phase === phaseIndex('twin', 'sun'), `clearing both twin orbs together enters the sun phase (phase was ${twinSunState.phase})`);
  // Two players in this lobby: boss HP scales linearly with headcount.
  const twinSunHp = phaseHp('twin', 'sun', 2);
  check(twinSunState.boss.maxHp === twinSunHp, `twin's sun phase uses its own HP pool (x2 players=${twinSunHp}), got ${twinSunState.boss.maxHp}`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
