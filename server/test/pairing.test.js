import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connect, fileMeta } from '../testutil/helpers.js';

test('sender creates a session, receiver joins by code', async () => {
  const { url, cleanup } = await setup();

  const sender = await connect(url);
  const files = [fileMeta('f1', 5, 5, { name: 'a.txt', type: 'text/plain' })];
  sender.sendJson({ type: 'HELLO', files });
  const session = await sender.next();
  assert.equal(session.type, 'SESSION');
  assert.match(session.code, /^\d{6}$/);

  const receiver = await connect(url);
  receiver.sendJson({ type: 'JOIN', code: session.code });
  const joined = await receiver.next();
  assert.equal(joined.type, 'JOINED');
  assert.equal(joined.sessionId, session.sessionId);
  assert.deepEqual(joined.files, [{ ...files[0], status: 'PENDING' }]);

  assert.equal((await sender.next()).type, 'PEER_JOINED');

  receiver.close();
  assert.equal((await sender.next()).type, 'PEER_LEFT');

  sender.close();
  await cleanup();
});

test('unknown code and bad input return errors', async () => {
  const { url, cleanup } = await setup();
  const ws = await connect(url);

  ws.sendJson({ type: 'JOIN', code: '000000' });
  assert.equal((await ws.next()).code, 'NO_SUCH_CODE');

  ws.send('not json');
  assert.equal((await ws.next()).code, 'BAD_JSON');

  ws.sendJson({ type: 'HELLO', files: [] });
  assert.equal((await ws.next()).code, 'BAD_HELLO');

  // size/chunkSize/chunks must agree: 10 bytes in 4-byte chunks is 3 chunks, not 2.
  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 10, 4, { chunks: 2 })] });
  assert.equal((await ws.next()).code, 'BAD_HELLO');

  ws.sendJson({ type: 'HELLO', files: [fileMeta('../evil', 1, 1)] });
  assert.equal((await ws.next()).code, 'BAD_HELLO');

  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 1, 1)] });
  assert.equal((await ws.next()).type, 'SESSION');
  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 1, 1)] });
  assert.equal((await ws.next()).code, 'ALREADY_STARTED');

  ws.close();
  await cleanup();
});
