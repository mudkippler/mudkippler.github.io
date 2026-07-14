// E2E coverage of bombardment's "launch codes" phase: each player gets their
// own maze (see the launchCodes behavior in server/phases.js), touching a
// wall kills instantly, and reaching the exit clears the phase.
const { check, finish, makeClient, sleep, phaseIndex } = require('./helpers');

async function damageBossUntil(client, predicate, maxHits = 550) {
  for (let i = 0; i < maxHits; i++) {
    client.send({ type: 'bossDamage' });
    await sleep(55);
    const s = client.lastState();
    if (s && predicate(s)) return s;
  }
  return client.lastState();
}

// Keeps re-sending the same reported position until the server accepts it
// (its anti-teleport cap grows with time since the last accepted report, so
// a jump further than the cap allows just needs a couple of retries) or the
// player dies.
async function moveToward(client, x, y, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    client.send({ type: 'movementUpdate', keys: {}, x, y });
    await sleep(90);
    const me = client.me();
    if (!me) continue;
    if (me.dead) return 'dead';
    if (Math.hypot(me.x - x, me.y - y) < 2) return 'arrived';
  }
  return 'timeout';
}

// Reconstructs which internal cell-to-cell edges are open (no wall) from the
// maze's wall segment list, so the test can walk a real corridor path
// instead of a straight line that would clip through walls and die.
function buildGraph(maze) {
  const gridSize = Math.round((maze.exit.x - maze.start.x) / maze.cellSize) + 1;
  const cs = maze.cellSize;
  const ox = maze.start.x - cs / 2;
  const oy = maze.start.y - cs / 2;
  const close = (a, b) => Math.abs(a - b) < 1;
  const hasWall = (x1, y1, x2, y2) => maze.walls.some(w =>
    (close(w.x1, x1) && close(w.y1, y1) && close(w.x2, x2) && close(w.y2, y2)) ||
    (close(w.x1, x2) && close(w.y1, y2) && close(w.x2, x1) && close(w.y2, y1))
  );

  const open = new Set();
  const key = (cx, cy, dir) => `${cx},${cy},${dir}`;
  for (let cy = 0; cy < gridSize; cy++) {
    for (let cx = 0; cx < gridSize; cx++) {
      const x0 = ox + cx * cs, y0 = oy + cy * cs, x1 = x0 + cs, y1 = y0 + cs;
      if (cx + 1 < gridSize && !hasWall(x1, y0, x1, y1)) {
        open.add(key(cx, cy, 'E'));
        open.add(key(cx + 1, cy, 'W'));
      }
      if (cy + 1 < gridSize && !hasWall(x0, y1, x1, y1)) {
        open.add(key(cx, cy, 'S'));
        open.add(key(cx, cy + 1, 'N'));
      }
    }
  }
  return { gridSize, open, cellCenter: (cx, cy) => ({ x: ox + cs * (cx + 0.5), y: oy + cs * (cy + 0.5) }) };
}

function solvePath(graph) {
  const { gridSize, open } = graph;
  const DIRS = [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']];
  const goal = `${gridSize - 1},${gridSize - 1}`;
  const prev = new Map();
  const seen = new Set(['0,0']);
  const queue = [[0, 0]];
  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (`${cx},${cy}` === goal) break;
    for (const [dx, dy, dir] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
      if (!open.has(key(cx, cy, dir))) continue;
      const nk = `${nx},${ny}`;
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, [cx, cy]);
      queue.push([nx, ny]);
    }
  }
  function key(cx, cy, dir) { return `${cx},${cy},${dir}`; }
  if (!seen.has(goal)) throw new Error('maze BFS found no path — generator produced a disconnected maze');
  const path = [[gridSize - 1, gridSize - 1]];
  let cur = goal;
  while (cur !== '0,0') {
    const p = prev.get(cur);
    path.push(p);
    cur = `${p[0]},${p[1]}`;
  }
  return path.reverse();
}

(async () => {
  // --- Reaching the exit advances the phase ---
  const host = makeClient('host');
  await host.open;
  host.send({ type: 'createLobby', name: 'Alice', encounter: 'bombardment' });
  const joined = await host.waitFor('joined');
  host.id = joined.id;

  host.send({ type: 'startGame' });
  await host.waitFor('gameStart');
  await host.waitFor('state');

  const LAUNCH_CODES = phaseIndex('bombardment', 'launchCodes');
  await damageBossUntil(host, s => s.phase === LAUNCH_CODES);
  check(host.lastState().phase === LAUNCH_CODES, `depleting the main boss HP enters launch codes (phase was ${host.lastState().phase})`);

  const layout = await host.waitFor('mazeLayout');
  const maze = layout.mazes[host.id];
  check(!!maze && Array.isArray(maze.walls) && maze.walls.length > 0, "mazeLayout includes this player's walls");
  check(typeof layout.timeLimit === 'number' && layout.timeLimit > 0, 'mazeLayout includes a time limit');

  await sleep(150);
  const spawned = host.me();
  check(Math.hypot(spawned.x - maze.start.x, spawned.y - maze.start.y) < 2, 'player was teleported to their maze start');

  const graph = buildGraph(maze);
  const path = solvePath(graph);
  let walkFailed = null;
  for (const [cx, cy] of path.slice(1)) {
    const { x, y } = graph.cellCenter(cx, cy);
    const result = await moveToward(host, x, y);
    if (result !== 'arrived') { walkFailed = `${result} at cell (${cx},${cy})`; break; }
  }
  check(walkFailed === null, `walked the solved corridor path to the exit without dying${walkFailed ? ` (failed: ${walkFailed})` : ''}`);

  await sleep(300);
  const cleared = host.lastState();
  check(cleared.phase === phaseIndex('bombardment', 'enrage'), `reaching the exit advances past launch codes (phase was ${cleared.phase})`);

  // --- Touching a wall kills instantly ---
  const host2 = makeClient('host2');
  await host2.open;
  host2.send({ type: 'createLobby', name: 'Bob', encounter: 'bombardment' });
  const joined2 = await host2.waitFor('joined');
  host2.id = joined2.id;

  host2.send({ type: 'startGame' });
  await host2.waitFor('gameStart');
  await host2.waitFor('state');

  await damageBossUntil(host2, s => s.phase === LAUNCH_CODES);
  const layout2 = await host2.waitFor('mazeLayout');
  const maze2 = layout2.mazes[host2.id];

  // The start cell's own top boundary wall is always present in every maze —
  // no BFS needed to find a guaranteed wall to walk into.
  const result = await moveToward(host2, maze2.start.x, maze2.start.y - maze2.cellSize / 2);
  check(result === 'dead', `touching a maze wall kills the player (got "${result}")`);

  finish();
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
