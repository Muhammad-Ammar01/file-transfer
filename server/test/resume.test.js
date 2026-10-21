import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { setup } from '../testutil/helpers.js';
import { uploadAll, joinAs, downloadBytes, toFile } from '../testutil/flow.js';
import { SessionSender } from '../../client/src/sessionSender.js';

const readStored = (storageDir, sessionId, fid) => fs.readFile(path.join(storageDir, sessionId, fid, 'file'));

test('sender reconnects after a dropped connection and sends only the missing chunks', async () => {
  const { storageDir, url, cleanup } = await setup();
  const data = randomBytes(40_000); // 40 chunks
  let dropped = false;
  const sender = new SessionSender(url, {
    WebSocketImpl: WebSocket,
    chunkSize: 1000,
    windowSize: 2,
    onProgress: ({ done }) => {
      if (done === 5 && !dropped) {
        dropped = true;
        sender.ws.terminate();
      }
    },
  });
  await sender.connect();
  const { sessionId } = await sender.createSession([toFile(data)]);
  await sender.upload();
  sender.close();

  assert.ok(dropped);
  const { missing } = sender.plan.get('f0');
  assert.ok(missing.size > 0 && missing.size < 40, `resumed with ${missing.size} chunks missing`);
  assert.deepEqual(await readStored(storageDir, sessionId, 'f0'), data);

  await cleanup();
});

test('a brand-new sender can continue a half-finished session', async () => {
  const { storageDir, url, cleanup } = await setup();
  const data = randomBytes(30_000);
  const files = [toFile(data)];

  let dropped = false;
  const first = new SessionSender(url, {
    WebSocketImpl: WebSocket,
    chunkSize: 1000,
    windowSize: 2,
    maxReconnects: 0,
    onProgress: ({ done }) => {
      if (done === 4 && !dropped) {
        dropped = true;
        first.ws.terminate();
      }
    },
  });
  await first.connect();
  const { sessionId } = await first.createSession(files);
  await assert.rejects(first.upload(), /connection/);

  // e.g. the sender reloaded the page: new object, same files, same session id
  const second = new SessionSender(url, { WebSocketImpl: WebSocket, chunkSize: 1000 });
  second.useExistingSession(sessionId, files);
  await second.upload();
  second.close();

  assert.deepEqual(await readStored(storageDir, sessionId, 'f0'), data);
  await cleanup();
});

test('uploaded files survive a server restart and can still be received', async () => {
  const first = await setup();
  const data = randomBytes(5000);
  const { code } = await uploadAll(first.url, [toFile(data, 'report.pdf')]);
  await first.stop();

  const second = await setup(first.storageDir); // same storage folder = restarted server
  const { receiver, files } = await joinAs(second.url, code);
  assert.equal(files[0].name, 'report.pdf');
  assert.equal(files[0].status, 'READY');
  assert.deepEqual(await downloadBytes(receiver, files[0]), data);

  receiver.close();
  await second.cleanup();
});
