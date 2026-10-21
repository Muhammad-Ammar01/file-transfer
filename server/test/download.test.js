import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { setup, connect, fileMeta } from '../testutil/helpers.js';
import { uploadAll, joinAs, downloadBytes, toFile, waitFor, sleep } from '../testutil/flow.js';
import { SessionSender } from '../../client/src/sessionSender.js';
import { SessionReceiver } from '../../client/src/sessionReceiver.js';
import { MemorySink } from '../../client/src/sinks.js';

test('receiver downloads every file byte-for-byte and verifies it', async () => {
  const { url, cleanup } = await setup();
  const data = [randomBytes(4500), randomBytes(1000), Buffer.alloc(0)];
  const names = ['photo.jpg', 'doc.pdf', 'empty.txt'];
  const { code } = await uploadAll(url, data.map((d, i) => toFile(d, names[i])));

  const { receiver, files } = await joinAs(url, code);
  assert.deepEqual(files.map((f) => f.status), ['READY', 'READY', 'READY']);
  assert.deepEqual(files.map((f) => f.name), names);

  const progress = [];
  for (const [i, file] of files.entries()) {
    const got = await downloadBytes(receiver, file, { onProgress: (p) => progress.push(p) });
    assert.deepEqual(got, data[i]);
  }
  assert.equal(progress.filter((p) => p.fid === 'f0').length, 5);
  assert.equal(progress.at(-1).done, 1); // f1 is the last file with chunks

  receiver.close();
  await cleanup();
});

test('receiver sees live PROGRESS and READY while the sender is still uploading', async () => {
  const { url, cleanup } = await setup();
  const sender = new SessionSender(url, { WebSocketImpl: WebSocket, chunkSize: 1000 });
  await sender.connect();
  const { code } = await sender.createSession([toFile(randomBytes(3500), 'clip.mp4', 'video/mp4')]);

  const events = [];
  const { receiver, files } = await joinAs(url, code, { onEvent: (e) => events.push(e) });
  assert.equal(files[0].status, 'PENDING');

  await sender.upload();
  await waitFor(() => events.some((e) => e.type === 'READY'));

  const progress = events.filter((e) => e.type === 'PROGRESS');
  assert.equal(progress.length, 4);
  assert.equal(progress.at(-1).done, 4);
  assert.deepEqual(events.find((e) => e.type === 'READY'), {
    type: 'READY', fid: 'f0', name: 'clip.mp4', size: 3500, mime: 'video/mp4',
  });

  sender.close();
  receiver.close();
  await cleanup();
});

test('GET is refused before JOIN and before the file is READY', async () => {
  const { url, cleanup } = await setup();
  const stranger = await connect(url);
  stranger.sendJson({ type: 'GET', fid: 'f0' });
  assert.equal((await stranger.next()).code, 'NOT_JOINED');

  const sender = await connect(url);
  sender.sendJson({ type: 'HELLO', files: [fileMeta('f0', 2000, 1000)] });
  const { code } = await sender.next();

  const receiver = await connect(url);
  receiver.sendJson({ type: 'JOIN', code });
  await receiver.next();
  receiver.sendJson({ type: 'GET', fid: 'f0' });
  assert.equal((await receiver.next()).code, 'NOT_READY');
  receiver.sendJson({ type: 'GET', fid: 'nope' });
  assert.equal((await receiver.next()).code, 'UNKNOWN_FILE');

  for (const ws of [stranger, sender, receiver]) ws.close();
  await cleanup();
});

test('a file altered on the server is caught by the receiver', async () => {
  const { storageDir, url, cleanup } = await setup();
  const { sessionId, code } = await uploadAll(url, [toFile(randomBytes(2500))]);
  await fs.writeFile(path.join(storageDir, sessionId, 'f0', 'file'), randomBytes(2500));

  const { receiver, files } = await joinAs(url, code);
  await assert.rejects(downloadBytes(receiver, files[0]), /failed its hash check/);

  receiver.close();
  await cleanup();
});

test('a download resumes from the next chunk after the connection drops', async () => {
  const { url, cleanup } = await setup();
  const data = randomBytes(300_000); // 300 chunks of 1000 bytes
  const { code } = await uploadAll(url, [toFile(data)]);
  const { receiver, files } = await joinAs(url, code);

  let connects = 0;
  const connect = receiver.connect.bind(receiver);
  receiver.connect = () => (connects++, connect());

  // A slow sink guarantees the drop lands mid-stream, with most chunks still unprocessed.
  const sink = new MemorySink();
  let dropped = false;
  sink.write = async (bytes) => {
    MemorySink.prototype.write.call(sink, bytes);
    if (!dropped) {
      dropped = true;
      receiver.ws.terminate();
    }
    await sleep(1);
  };
  await receiver.download(files[0], sink);

  assert.equal(connects, 1, 'reconnected exactly once');
  assert.deepEqual(Buffer.concat(sink.chunks), data);

  receiver.close();
  await cleanup();
});

test('the receiver class reports a server error instead of hanging', async () => {
  const { url, cleanup } = await setup();
  const receiver = new SessionReceiver(url, { WebSocketImpl: WebSocket });
  await receiver.connect();
  await assert.rejects(receiver.join('000000'), /NO_SUCH_CODE/);
  receiver.close();
  await cleanup();
});
