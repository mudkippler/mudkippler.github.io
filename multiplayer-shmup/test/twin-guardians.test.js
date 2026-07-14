// E2E coverage of the reworked Twin Guardian fight: main → orbs (now a sun
// and moon pair) → sun phase (server-broadcast ray/glow/moon mech values) →
// moon phase (server-seeded stars) → eclipse (converge fraction ramping to
// totality) → enrage → defeated, plus the zone damage sources ('ray',
// 'dark', 'star') the sun/moon phases report.
const { check, finish, makeClient, sleep, phaseIndex, phaseHp, phaseField } = require('./helpers');

const ORBS = phaseIndex('twin', 'orbs');
const SUN = phaseIndex('twin', 'sun');
const MOON = phaseIndex('twin', 'moon');
const ECLIPSE = phaseIndex('twin', 'eclipse');
const ENRAGE = phaseIndex('twin', 'enrage');
const DEFEATED = phaseIndex('twin', 'defeated');

// Both clients spam bossDamage until the lobby state satisfies `predicate`.
async function depleteUntil(clients, predicate, maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    for (const c of clients) c.send({ type: 'bossDamage' });
    await sleep(55);
    const s = clients[0].lastState();
    if (s && predicate(s)) return s;
  }
  return clients[0].lastState();
}

(async () => {
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'twin' });
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

  // --- Orb phase: the orbs now carry sun/moon kinds ---
  await depleteUntil([host, friend], s => s.phase === ORBS);
  const orbState = host.lastState();
  check(orbState.phase === ORBS, `main depletion enters the orb phase (was ${orbState.phase})`);
  const kinds = (orbState.orbs || []).map(o => o.kind);
  check(kinds.length === 2 && kinds.includes('sun') && kinds.includes('moon'),
    `orbs are a sun/moon pair (kinds: ${JSON.stringify(kinds)})`);

  // --- Kill both orbs together → sun phase ---
  // Hit count derived from orbHp (rather than a fixed guess) so it stays
  // correct whether FAST_TESTS is scaling that pool down or not.
  const orbHits = Math.ceil(phaseHp('twin', 'orbs', 1, 'orbHp') / 10) + 2;
  await Promise.all([
    (async () => { for (let i = 0; i < orbHits; i++) { host.send({ type: 'orbDamage', orbId: 0 }); await sleep(55); } })(),
    (async () => { for (let i = 0; i < orbHits; i++) { friend.send({ type: 'orbDamage', orbId: 1 }); await sleep(55); } })()
  ]);
  await sleep(300);
  let s = host.lastState();
  check(s.phase === SUN, `clearing the orbs together enters the sun phase (was ${s.phase})`);
  const twinSunHp = phaseHp('twin', 'sun', 2);
  check(s.boss.maxHp === twinSunHp, `sun phase HP pool scaled for 2 players (got ${s.boss.maxHp}, expected ${twinSunHp})`);

  // --- Sun phase mech broadcast: rotating rays, pulsing glow, orbiting moon ---
  await sleep(300);
  s = host.lastState();
  check(s.mech && typeof s.mech.ray === 'number' && typeof s.mech.glow === 'number',
    `sun phase broadcasts ray/glow mech values (${JSON.stringify(s.mech)})`);
  check(s.mech && s.mech.moon && typeof s.mech.moon.x === 'number', 'sun phase broadcasts the moon satellite position');
  const orbitDist = Math.hypot(s.mech.moon.x - s.boss.x, s.mech.moon.y - s.boss.y);
  check(Math.abs(orbitDist - 140) < 2, `moon orbits at its configured radius (140, got ${orbitDist.toFixed(1)})`);

  const sampleA = host.lastState().mech;
  await sleep(1000);
  const sampleB = host.lastState().mech;
  check(sampleA.ray !== sampleB.ray, `rays rotate over time (${sampleA.ray} -> ${sampleB.ray})`);
  check(sampleA.moon.x !== sampleB.moon.x || sampleA.moon.y !== sampleB.moon.y,
    'the moon satellite actually moves along its orbit');

  // --- Zone damage sources land with their server-defined amounts ---
  friend.send({ type: 'playerDamage', source: 'ray' });
  await sleep(250);
  check(friend.me().health === 88, `'ray' zone tick costs 12 HP (health ${friend.me().health})`);
  friend.send({ type: 'playerDamage', source: 'dark' });
  await sleep(250);
  check(friend.me().health === 80, `'dark' zone tick costs 8 HP (health ${friend.me().health})`);
  friend.send({ type: 'playerDamage', source: 'star' });
  await sleep(250);
  check(friend.me().health === 55, `'star' explosion costs 25 HP (health ${friend.me().health})`);

  // --- Deplete the sun → moon phase: server seeds stars ---
  await depleteUntil([host, friend], s => s.phase === MOON);
  s = host.lastState();
  check(s.phase === MOON, `sun depletion enters the moon phase (was ${s.phase})`);
  check(s.mech === undefined, 'moon phase carries no per-tick mech payload');

  const star1 = await host.waitForNext('star', 3000);
  const star2 = await friend.waitForNext('star', 3000);
  const inBounds = st => st.x >= 60 && st.x <= 740 && st.y >= 80 && st.y <= 520;
  check(inBounds(star1) && inBounds(star2),
    `seeded stars land inside the arena (${JSON.stringify({ x: star1.x, y: star1.y })})`);

  // --- Deplete the moon → eclipse: converge fraction ramps to totality ---
  await depleteUntil([host, friend], s => s.phase === ECLIPSE);
  s = host.lastState();
  check(s.phase === ECLIPSE, `moon depletion enters the eclipse (was ${s.phase})`);
  const twinEclipseHp = phaseHp('twin', 'eclipse', 2);
  check(s.boss.maxHp === twinEclipseHp, `eclipse HP pool scaled for 2 players (got ${s.boss.maxHp}, expected ${twinEclipseHp})`);
  check(s.mech && s.mech.moonT >= 0 && s.mech.moonT <= 1, `eclipse broadcasts the converge fraction (${s.mech && s.mech.moonT})`);
  await sleep(phaseField('twin', 'eclipse', 'convergeMs') + 400); // pad past the converge duration
  check(host.lastState().mech.moonT === 1, `totality reached after the converge duration (moonT=${host.lastState().mech.moonT})`);

  // --- Eclipse → enrage → defeated: the fight still ends like every other ---
  await depleteUntil([host, friend], s => s.phase === ENRAGE);
  check(host.lastState().phase === ENRAGE, 'eclipse depletion enters the enrage chase');
  await depleteUntil([host, friend], s => s.phase === DEFEATED);
  check(host.lastState().phase === DEFEATED, 'enrage depletion defeats the boss');

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
