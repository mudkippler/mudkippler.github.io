// E2E coverage of the lobby system: create/join, encounters, host controls,
// multiple concurrent lobbies, and host handoff.
const { check, finish, makeClient, sleep } = require('./helpers');

(async () => {
  // Host creates a lobby with the 'storm' encounter
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'storm' });
  const joined = await host.waitFor('joined');
  check(/^[A-Z2-9]{5}$/.test(joined.code), `lobby code format (${joined.code})`);
  check(joined.hostId === joined.id, 'creator is host');
  check(joined.started === false, 'lobby not started on create');
  check(joined.encounter.id === 'storm' && joined.boss.maxHp === 3500, 'storm encounter applied (boss 3500 HP)');

  // Friend joins via the code, providing a name
  const friend = makeClient('friend');
  await friend.open;
  friend.send({ type: 'joinLobby', code: joined.code.toLowerCase(), name: '  Bob the Great  ' });
  const fJoined = await friend.waitFor('joined');
  check(fJoined.code === joined.code, 'friend joined same lobby (lowercase code accepted)');
  check(fJoined.hostId === joined.id, 'friend sees correct host');

  const lobbyState = await friend.waitFor('lobbyState');
  const names = lobbyState.players.map(p => p.name).sort();
  check(names.join(',') === 'Alice,Bob the Great', `lobby roster has both names (${names.join(',')})`);

  // A second, independent lobby can exist at the same time
  const other = makeClient('other');
  await other.open;
  other.send({ type: 'createLobby', name: 'Carol', encounter: 'twin' });
  const oJoined = await other.waitFor('joined');
  check(oJoined.code !== joined.code, 'second lobby has a different code');
  check(oJoined.encounter.id === 'twin' && oJoined.boss.maxHp === 2500, 'second lobby has its own encounter');

  // Non-host cannot start; host can
  friend.send({ type: 'startGame' });
  await sleep(300);
  check(!friend.messages.some(m => m.type === 'gameStart'), 'non-host startGame ignored');

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  await friend.waitFor('gameStart');
  check(true, 'host start reaches both lobby members');

  // Started lobby streams state; the other (unstarted) lobby gets none
  const state = await host.waitFor('state');
  check(state.players.length === 2 && state.players.every(p => p.name), 'state includes both players with names');
  await sleep(300);
  check(!other.messages.some(m => m.type === 'state' || m.type === 'gameStart'), 'unstarted lobby receives no game state');

  // Late joiner drops straight into the running game
  const late = makeClient('late');
  await late.open;
  late.send({ type: 'joinLobby', code: joined.code, name: 'Dave' });
  const lJoined = await late.waitFor('joined');
  check(lJoined.started === true, 'late joiner sees started=true');

  // Damage goes to the right lobby's boss. Two players were in this lobby
  // when the fight started (boss HP scales linearly with headcount), so the
  // pool is 3500 x2 = 7000 — the late joiner below doesn't retroactively
  // rescale it.
  host.send({ type: 'bossDamage' });
  await sleep(300);
  const lastState = [...host.messages].reverse().find(m => m.type === 'state');
  const otherBossFine = ![...other.messages].some(m => m.type === 'state');
  check(lastState.boss.hp === 6990 && otherBossFine, `boss damage scoped to own lobby (hp=${lastState.boss.hp})`);

  // Leaderboard carries names — wait for a fresh broadcast (one sent after
  // bossDamage above), not a stale one already queued from before it.
  const lb = await host.waitForNext('leaderboard', 3000);
  const entry = Object.values(lb.damageLog).find(e => e.name === 'Alice');
  check(entry && entry.dmg >= 10, 'leaderboard entry has name and damage');

  // Bad code errors cleanly
  const lost = makeClient('lost');
  await lost.open;
  lost.send({ type: 'joinLobby', code: 'ZZZZZ', name: 'Eve' });
  const err = await lost.waitFor('lobbyError');
  check(/not found/.test(err.message), `bad code rejected (${err.message})`);

  // Host leaving transfers host to the next player
  host.ws.close();
  const newState = await new Promise((res, rej) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const m = [...friend.messages].reverse().find(m => m.type === 'lobbyState' && m.hostId !== joined.id);
      if (m) { clearInterval(poll); res(m); }
      else if (Date.now() - start > 3000) { clearInterval(poll); rej(new Error('timeout waiting for host transfer')); }
    }, 20);
  });
  check(newState.hostId === fJoined.id || newState.players.some(p => p.id === newState.hostId), 'host reassigned after host left');

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
