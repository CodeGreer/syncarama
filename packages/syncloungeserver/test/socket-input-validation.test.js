/* eslint-disable import/no-extraneous-dependencies, no-await-in-loop, no-restricted-syntax */
// socket.io-client is intentionally supplied by the root application package.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test, before, after } = require('node:test');
const { io } = require('socket.io-client');

const port = 18000 + Math.floor(Math.random() * 1000);
const serverUrl = `http://127.0.0.1:${port}`;
let server;

const waitForEvent = (emitter, eventName, timeout = 3000) => Promise.race([
  once(emitter, eventName).then(([value]) => value),
  new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeout);
  }),
]);

const waitForHealth = async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) {
        return response.json();
      }
    } catch (error) {
      // The child may still be starting.
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('Server did not become healthy');
};

const connect = async () => {
  const socket = io(serverUrl, { autoConnect: false, transports: ['websocket'] });
  const ping = waitForEvent(socket, 'slPing');
  socket.connect();
  socket.emit('slPong', await ping);
  return socket;
};

const validState = {
  state: 'stopped', time: 0, duration: 0, playbackRate: 0,
};

const join = async (socket, roomId) => {
  const result = waitForEvent(socket, 'joinResult');
  socket.emit('join', { roomId, ...validState, media: null });
  assert.equal((await result).success, true);
};

const assertHealthy = async () => {
  assert.equal(server.exitCode, null, 'server child process exited');
  assert.deepEqual(await waitForHealth(), { load: 'low' });
};

before(async () => {
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: new URL('..', `file://${__filename}`).pathname,
    env: { ...process.env, PORT: String(port), BASE_URL: '/' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth();
});

after(async () => {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});

test('malformed pre-room joins cannot terminate the server', async () => {
  const payloads = [undefined, null, 'room', 1, [], {}, { roomId: 'room' }, {
    roomId: 42, ...validState,
  }, { roomId: 'room', ...validState, duration: '0' }];

  for (const payload of payloads) {
    const socket = await connect();
    if (payload === undefined) socket.emit('join');
    else socket.emit('join', payload);
    await waitForEvent(socket, 'disconnect');
    await assertHealthy();
  }
});

test('malformed participant playback events are ignored and the server stays healthy', async () => {
  const socket = await connect();
  await join(socket, 'malformed-playback');
  const malformed = [undefined, null, 'state', 1, [], {}, { state: 'playing' }, {
    ...validState, time: '0',
  }];

  for (const eventName of ['playerStateUpdate', 'mediaUpdate']) {
    for (const payload of malformed) {
      if (payload === undefined) socket.emit(eventName);
      else socket.emit(eventName, payload);
    }
  }
  socket.emit('mediaUpdate', { ...validState, media: [], userInitiated: false });
  socket.emit('mediaUpdate', { ...validState, media: null, userInitiated: 'yes' });

  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(socket.connected, true);
  await assertHealthy();
  socket.disconnect();
});

test('legitimate joins and playback updates still propagate', async () => {
  const sender = await connect();
  const receiver = await connect();
  await join(sender, 'positive-path');
  await join(receiver, 'positive-path');

  const playerUpdate = waitForEvent(receiver, 'playerStateUpdate');
  sender.emit('playerStateUpdate', {
    state: 'paused', time: 1250, duration: 0, playbackRate: 0,
  });
  assert.equal((await playerUpdate).time, 1250);

  const mediaUpdate = waitForEvent(receiver, 'mediaUpdate');
  sender.emit('mediaUpdate', {
    state: 'stopped',
    time: 0,
    duration: 0,
    playbackRate: 0,
    media: null,
    userInitiated: false,
  });
  assert.equal((await mediaUpdate).media, null);

  await assertHealthy();
  sender.disconnect();
  receiver.disconnect();
});
