// Runs every *.test.js suite in this directory against a real server
// instance spun up on a dedicated test port, then tears it down.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = process.env.TEST_PORT || 3100;
const SERVER_PATH = path.join(__dirname, '..', 'server', 'server.js');

function waitForServer(timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('server did not start in time'));
        setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, TEST_PORT },
      stdio: 'inherit'
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  const suites = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => path.join(__dirname, f));

  if (suites.length === 0) {
    console.log('No test suites found (*.test.js).');
    process.exit(0);
  }

  const server = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: TEST_PORT },
    stdio: 'ignore'
  });

  let allPassed = true;
  try {
    await waitForServer();
    for (const suite of suites) {
      console.log(`\n--- ${path.basename(suite)} ---`);
      const passed = await runSuite(suite);
      allPassed = allPassed && passed;
    }
  } finally {
    server.kill();
  }

  console.log(allPassed ? '\n=== ALL SUITES PASSED ===' : '\n=== SOME SUITES FAILED ===');
  process.exit(allPassed ? 0 : 1);
})();
