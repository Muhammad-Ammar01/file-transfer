import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setup, connect } from '../testutil/helpers.js';
import { uploadAll, toFile } from '../testutil/flow.js';
import { runCleanup, DEFAULT_TTL_MS } from '../src/cleanup.js';

test('cleanup removes expired sessions from disk, the database and memory', async () => {
  const { wss, storageDir, url, cleanup } = await setup();
  const { sessionId, code } = await uploadAll(url, [toFile(randomBytes(2500))]);
  await fs.stat(path.join(storageDir, sessionId, 'f0', 'file'));

  // Not old enough yet: nothing happens.
  assert.equal(await runCleanup(wss.ctx, DEFAULT_TTL_MS), 0);
  await fs.stat(path.join(storageDir, sessionId));

  // Pretend a day and a bit has passed.
  assert.equal(await runCleanup(wss.ctx, DEFAULT_TTL_MS, Date.now() + DEFAULT_TTL_MS + 1000), 1);
  await assert.rejects(fs.stat(path.join(storageDir, sessionId)));
  assert.equal(wss.ctx.db.listSessions().length, 0);
  assert.equal(wss.ctx.db.getFile(sessionId, 'f0'), undefined);

  const ws = await connect(url);
  ws.sendJson({ type: 'JOIN', code });
  assert.equal((await ws.next()).code, 'NO_SUCH_CODE');

  ws.close();
  await cleanup();
});
