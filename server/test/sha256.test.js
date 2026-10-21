import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256Bytes } from '../../client/src/sha256.js';

test('JS SHA-256 fallback matches node:crypto at every padding boundary', () => {
  for (const len of [0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 100_003]) {
    const data = randomBytes(len);
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(Buffer.from(sha256Bytes(new Uint8Array(data))).toString('hex'), expected, `length ${len}`);
  }
});

test('JS SHA-256 fallback works on a subarray view', () => {
  const data = randomBytes(500);
  const view = new Uint8Array(data.buffer, data.byteOffset + 7, 300);
  assert.equal(
    Buffer.from(sha256Bytes(view)).toString('hex'),
    createHash('sha256').update(view).digest('hex'),
  );
});
