// E2E coverage of: bottom-center spawn positioning, distinct player colors,
// and gradual (not instant) revive-progress decay.
const { check, finish, makeClient, sleep, kill } = require('./helpers');

(async () => {
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'blitz' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;
  check(joined.boss !== undefined, 'joined ok');
  check(joined.boss.x === 400 && joined.boss.y === 100, 'boss at expected top position');

  const clients = [host];
  for (let i = 0; i < 5; i++) {
    const c = makeClient('p' + i);
    await c.open;
    c.send({ type: 'joinLobby', code: joined.code, name: 'P' + i });
    const j = await c.waitFor('joined');
    c.id = j.id;
    clients.push(c);
  }

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  await host.waitFor('state');
  await sleep(200);

  const state = host.lastState();
  let allBottom = true, colors = new Set();
  for (const p of state.players) {
    if (p.y < 500 || p.x < 300 || p.x > 500) allBottom = false;
    colors.add(p.color);
  }
  check(allBottom, `all ${state.players.length} players spawn near bottom-center (sample: ${JSON.stringify(state.players.map(p => [p.x, p.y]))})`);
  check(colors.size === state.players.length, `all ${state.players.length} players have distinct colors (${[...colors].join(',')})`);
  check([...colors].every(c => /^#[0-9a-f]{6}$/i.test(c)), 'colors are hex from the fixed palette');

  // Revive decay: build some progress, walk clear of the revive radius, and
  // confirm progress drains gradually rather than snapping to 0. Uses a
  // fresh 2-player lobby so no bystanders (everyone spawns clustered at
  // bottom-center) sit within the revive radius and keep progress climbing.
  const rHost = makeClient('rHost');
  await rHost.open;
  rHost.send({ type: 'createLobby', name: 'RHost', encounter: 'blitz' });
  const rJoined = await rHost.waitFor('joined');
  rHost.id = rJoined.id;

  const friend = makeClient('rFriend');
  await friend.open;
  friend.send({ type: 'joinLobby', code: rJoined.code, name: 'RFriend' });
  const rfJoined = await friend.waitFor('joined');
  friend.id = rfJoined.id;

  rHost.send({ type: 'startGame' });
  await rHost.waitFor('gameStart');
  await rHost.waitFor('state');

  await kill(friend);
  await friend.waitFor('dead');

  const body = () => rHost.find(friend.id);
  const hostPos = () => { const s = rHost.lastState(); return s.players.find(p => p.id === rHost.id); };

  // Walk onto the body and hold position until partial progress builds
  for (let i = 0; i < 40; i++) {
    const me = hostPos(), target = body();
    if (!me || !target) break;
    const dx = target.x - me.x, dy = target.y - me.y;
    if (Math.hypot(dx, dy) < 10) { rHost.send({ type: 'movementUpdate', keys: { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false } }); break; }
    rHost.send({ type: 'movementUpdate', keys: { ArrowLeft: dx < -3, ArrowRight: dx > 3, ArrowUp: dy < -3, ArrowDown: dy > 3 } });
    await sleep(80);
  }
  await sleep(1000); // accumulate some progress, well short of the 3000ms full revive
  const midProgress = body()?.revive || 0;
  check(midProgress > 0 && midProgress < 1, `partial revive progress built (${midProgress})`);

  // Walk clearly outside REVIVE_RADIUS (30px) before measuring decay — move
  // directly away from the body's position, not a fixed compass direction.
  let clearedRadius = false;
  for (let i = 0; i < 30; i++) {
    const me = hostPos(), target = body();
    if (!me || !target) break;
    const dx = me.x - target.x, dy = me.y - target.y;
    if (Math.hypot(dx, dy) > 60) { clearedRadius = true; break; }
    rHost.send({ type: 'movementUpdate', keys: { ArrowLeft: dx < 0, ArrowRight: dx >= 0, ArrowUp: dy < 0, ArrowDown: dy >= 0 } });
    await sleep(80);
  }
  rHost.send({ type: 'movementUpdate', keys: { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false } });
  await sleep(150); // let the "outside radius" state land before sampling
  check(clearedRadius, 'host walked clear of the revive radius');
  const justLeft = body()?.revive || 0;

  await sleep(600);
  const afterDecay = body()?.revive || 0;
  check(justLeft > 0, `revive progress survives immediately after leaving the radius (${justLeft})`);
  check(afterDecay < justLeft, `revive progress decays gradually after leaving (${justLeft} -> ${afterDecay})`);
  check(afterDecay > 0, `revive progress has not been wiped to 0 after only 600ms of decay (${afterDecay})`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
