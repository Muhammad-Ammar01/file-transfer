import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { setup } from '../testutil/helpers.js';
import { uploadAll, joinAs } from '../testutil/flow.js';
import { ZipWriter, safeZipPath } from '../../client/src/zipAll.js';
import { MemorySink } from '../../client/src/sinks.js';

// fflate is a client dependency; load its unzip from there to check the ZIP we build.
const { unzipSync } = createRequire(new URL('../../client/package.json', import.meta.url))('fflate');

// A File that looks like it came from a picked folder.
function folderFile(path, bytes) {
  const file = new File([bytes], path.split('/').pop(), { type: 'image/jpeg' });
  file.relativePath = path;
  return file;
}

test('987 images from nested folders: one send, then "Download all" as a ZIP', async () => {
  const { url, cleanup } = await setup();

  const originals = new Map();
  const files = [];
  for (let i = 0; i < 987; i++) {
    const path = `Holiday/Day ${(i % 3) + 1}/IMG_${String(i).padStart(4, '0')}.jpg`;
    const bytes = randomBytes(200 + (i % 50));
    originals.set(path, bytes);
    files.push(folderFile(path, bytes));
  }
  // An odd extra: an empty file and one that would escape the folder if unzipped naively.
  originals.set('Holiday/empty.txt', Buffer.alloc(0));
  files.push(folderFile('Holiday/empty.txt', Buffer.alloc(0)));
  files.push(folderFile('../../evil.jpg', Buffer.from('x')));

  const { code } = await uploadAll(url, files, { chunkSize: 1000 });
  const { receiver, files: listed } = await joinAs(url, code);
  assert.equal(listed.length, 989);
  assert.equal(listed[0].name, 'Holiday/Day 1/IMG_0000.jpg', 'folder path is kept');
  assert.equal(listed[10].name, 'Holiday/Day 2/IMG_0010.jpg', 'sender order is kept');
  assert.ok(listed.every((f) => f.status === 'READY'));

  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  for (const file of listed) await receiver.download(file, zip.entry(file.name));
  await zip.finish();

  const unzipped = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()));
  assert.equal(Object.keys(unzipped).length, 989);
  for (const [path, bytes] of originals) assert.deepEqual(Buffer.from(unzipped[path]), bytes, path);
  assert.ok(unzipped['evil.jpg'], '"../" was stripped from the path');
  assert.ok(!Object.keys(unzipped).some((p) => p.includes('..')));

  receiver.close();
  await cleanup();
});

test('ZIP paths are made safe and duplicates get a number', async () => {
  assert.equal(safeZipPath('../../a/./b.jpg'), 'a/b.jpg');
  assert.equal(safeZipPath('C:\\Users\\x.png'), 'C:/Users/x.png');
  assert.equal(safeZipPath('/'), 'file');

  const sink = new MemorySink();
  const zip = new ZipWriter(sink);
  for (const name of ['a.jpg', 'a.jpg', 'a.jpg', 'notes', 'notes']) {
    const entry = zip.entry(name);
    await entry.write(new Uint8Array([1]));
    await entry.close();
  }
  await zip.finish();
  const names = Object.keys(unzipSync(new Uint8Array(await sink.blob().arrayBuffer())));
  assert.deepEqual(names.sort(), ['a (2).jpg', 'a (3).jpg', 'a.jpg', 'notes', 'notes (2)']);
});
