// E2E coverage of shot relay, permadeath, stand-on-body revive, and the
// team-wipe encounter reset.
const WebSocket = require('ws');
const { check, finish, makeClient, sleep, kill, standOn } = require('./helpers');

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

  // --- Shot relay ---
  host.send({ type: 'shot', x: 123.4, y: 456.7 });
  const shot = await friend.waitFor('shot');
  check(shot.id === host.id && Math.abs(shot.x - 123.4) < 0.2 && !!shot.color, 'shot relayed to teammate with origin and color');
  await sleep(300);
  check(!host.messages.some(m => m.type === 'shot'), 'shooter does not receive its own shot back');

  // --- Permadeath ---
  await kill(friend);
  await friend.waitFor('dead');
  await sleep(300);
  check(friend.ws.readyState === WebSocket.OPEN, 'socket stays open after death (spectating)');
  let friendState = host.find(friend.id);
  check(friendState.dead === true && friendState.health === 0, 'dead flag and 0 health in state');
  const bodyX = friendState.x, bodyY = friendState.y;

  // Dead players cannot move or shoot
  friend.send({ type: 'movementUpdate', keys: { ArrowRight: true } });
  friend.send({ type: 'shot', x: 100, y: 100 });
  await sleep(500);
  friendState = host.find(friend.id);
  check(friendState.x === bodyX && friendState.y === bodyY, 'dead body stays where it fell');
  check(!host.messages.some(m => m.type === 'shot'), 'dead player shots not relayed');

  // --- Revive by standing on the body ---
  let sawProgress = false;
  const reviveWatcher = setInterval(() => {
    const f = host.find(friend.id);
    if (f && f.dead && f.revive > 0) sawProgress = true;
  }, 50);
  const revived = friend.waitFor('revived', 25000);
  const reached = await standOn(host, friend.id, () => {
    const f = host.find(friend.id);
    return f && !f.dead;
  });
  clearInterval(reviveWatcher);
  check(reached, 'reviver reached the body and revive completed');
  await revived;
  check(true, 'revived message delivered to the dead player');
  check(sawProgress, 'revive progress was broadcast while standing on body');
  await sleep(300);
  friendState = host.find(friend.id);
  check(friendState.dead === false && friendState.health === 50, `revived at half health (hp=${friendState.health})`);

  // --- Team wipe resets the encounter ---
  host.send({ type: 'bossDamage' }); // put some damage on the boss first
  await sleep(200);
  await Promise.all([kill(host), kill(friend)]);
  await host.waitFor('dead');
  await sleep(500);
  const wipeState = host.lastState();
  check(wipeState.players.every(p => p.dead), 'full party wipe registered');

  // TEAM_WIPE_RESET_DELAY is 900ms under FAST_TESTS (the default here — see
  // helpers.js), 4000ms otherwise (see server.js); pad past either.
  await sleep(process.env.FAST_TESTS === '0' ? 4500 : 1300);
  const resetState = host.lastState();
  check(resetState.players.every(p => !p.dead && p.health === 100), 'wipe reset revives everyone at full health');
  check(resetState.boss.hp === resetState.boss.maxHp, `wipe reset restores boss HP (${resetState.boss.hp}/${resetState.boss.maxHp})`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
