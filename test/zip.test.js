'use strict';

// Unit tests for the ZIP header and length math. Archives over 4 GiB are too
// slow to build in CI, so these use fake entry sizes and check the headers only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planZip, entryNames, MAX32 } = require('../src/zip');

const GiB = 1024 ** 3;

/** Lay the plan out with zero-filled stand-ins for entry contents too big to allocate. */
function headerAt(plan, wantedOffset) {
  let offset = 0;
  for (const part of plan.parts) {
    const len = part.buffer ? part.buffer.length : part.size;
    if (offset === wantedOffset && part.buffer) return part.buffer;
    offset += len;
  }
  return null;
}

function readExtra(buf, start, length) {
  const fields = {};
  for (let p = start; p < start + length;) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    fields[id] = buf.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return fields;
}

const u64s = (buf) => Array.from({ length: buf.length / 8 }, (_, i) => Number(buf.readBigUInt64LE(i * 8)));

test('zip: small archive needs no ZIP64 records and its length adds up', () => {
  const plan = planZip([
    { name: 'a.txt', size: 5, crc32: 0x12345678, mtime: Date.UTC(2026, 10, 8, 12, 0, 0) },
    { name: 'dir/b.bin', size: 0, crc32: 0, mtime: Date.UTC(2026, 10, 8) },
  ]);
  assert.equal(plan.zip64, false);
  const written = plan.parts.reduce((n, p) => n + (p.buffer ? p.buffer.length : p.size), 0);
  assert.equal(plan.length, written);
  const end = plan.parts.at(-1).buffer;
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(10), 2);
  // Local header: stored, UTF-8 flag, sizes and CRC in place.
  const local = plan.parts[0].buffer;
  assert.equal(local.readUInt32LE(0), 0x04034b50);
  assert.equal(local.readUInt16LE(6) & 0x0800, 0x0800);
  assert.equal(local.readUInt16LE(8), 0);
  assert.equal(local.readUInt32LE(14), 0x12345678);
  assert.equal(local.readUInt32LE(18), 5);
});

test('zip: entries over 4 GiB and offsets past 4 GiB use ZIP64 extra fields, end record and locator', () => {
  const big = 5 * GiB;
  const entries = [
    { name: 'huge.iso', size: big, crc32: 1, mtime: Date.now() },
    { name: 'after.txt', size: 10, crc32: 2, mtime: Date.now() },
  ];
  const plan = planZip(entries);
  assert.equal(plan.zip64, true);
  const written = plan.parts.reduce((n, p) => n + (p.buffer ? p.buffer.length : p.size), 0);
  assert.equal(plan.length, written);

  // Local header of the big entry: both sizes are 0xFFFFFFFF, the real ones in the extra field.
  const local1 = plan.parts[0].buffer;
  assert.equal(local1.readUInt32LE(18), MAX32);
  assert.equal(local1.readUInt32LE(22), MAX32);
  assert.equal(local1.readUInt16LE(4), 45);
  const nameLen1 = local1.readUInt16LE(26);
  const lx1 = readExtra(local1, 30 + nameLen1, local1.readUInt16LE(28));
  assert.deepEqual(u64s(lx1[1]), [big, big]);

  // Second entry starts past 4 GiB: its local header is where the plan says.
  const offset2 = local1.length + big;
  assert.ok(offset2 > MAX32);
  const local2 = headerAt(plan, offset2);
  assert.equal(local2.readUInt32LE(0), 0x04034b50);
  assert.equal(local2.readUInt32LE(18), 10); // its own size still fits: no local extra
  assert.equal(local2.readUInt16LE(28), 0);

  // Central directory.
  const end = plan.parts.at(-1).buffer;
  assert.equal(end.readUInt16LE(10), 2);
  assert.equal(end.readUInt32LE(16), MAX32); // offset overflowed: real value is in the ZIP64 record
  const locator = plan.parts.at(-2).buffer;
  assert.equal(locator.readUInt32LE(0), 0x07064b50);
  assert.equal(locator.readUInt32LE(16), 1);
  const z64Offset = Number(locator.readBigUInt64LE(8));
  const rec = headerAt(plan, z64Offset);
  assert.equal(rec.readUInt32LE(0), 0x06064b50);
  assert.equal(Number(rec.readBigUInt64LE(4)), 44);
  assert.equal(Number(rec.readBigUInt64LE(32)), 2);
  const cdSize = Number(rec.readBigUInt64LE(40));
  const cdOffset = Number(rec.readBigUInt64LE(48));
  assert.equal(cdOffset, offset2 + local2.length + 10);
  assert.equal(cdOffset + cdSize, z64Offset);
  assert.equal(z64Offset + rec.length + locator.length + end.length, plan.length);

  const cen1 = headerAt(plan, cdOffset);
  assert.equal(cen1.readUInt32LE(0), 0x02014b50);
  assert.equal(cen1.readUInt32LE(20), MAX32);
  assert.equal(cen1.readUInt32LE(24), MAX32);
  assert.equal(cen1.readUInt32LE(42), 0); // offset 0 still fits
  const cx1 = readExtra(cen1, 46 + cen1.readUInt16LE(28), cen1.readUInt16LE(30));
  assert.deepEqual(u64s(cx1[1]), [big, big]);

  const cen2 = headerAt(plan, cdOffset + cen1.length);
  assert.equal(cen2.readUInt32LE(20), 10);
  assert.equal(cen2.readUInt32LE(42), MAX32);
  const cx2 = readExtra(cen2, 46 + cen2.readUInt16LE(28), cen2.readUInt16LE(30));
  assert.deepEqual(u64s(cx2[1]), [offset2]); // only the offset overflowed
});

test('zip: more than 65535 entries forces the ZIP64 end record', () => {
  const entries = Array.from({ length: 70000 }, (_, i) => ({ name: `f${i}`, size: 0, crc32: 0, mtime: 0 }));
  const plan = planZip(entries);
  assert.equal(plan.zip64, true);
  const end = plan.parts.at(-1).buffer;
  assert.equal(end.readUInt16LE(10), 0xffff);
  const rec = plan.parts.at(-3).buffer;
  assert.equal(Number(rec.readBigUInt64LE(32)), 70000);
  const written = plan.parts.reduce((n, p) => n + (p.buffer ? p.buffer.length : p.size), 0);
  assert.equal(plan.length, written);
});

test('zip: entry names are relative to the folder, Windows-safe and de-duplicated', () => {
  const files = [
    { path: 'Trip', name: 'a.jpg' },
    { path: 'Trip', name: 'A.JPG' },
    { path: 'Trip', name: 'a.jpg' },
    { path: 'Trip/raw', name: 'what?.cr2' },
    { path: 'Trip/raw. ', name: 'notes' },
    { path: 'Trip/raw. ', name: 'notes' },
  ];
  assert.deepEqual(entryNames(files, 'Trip'), [
    'a.jpg', 'A (2).JPG', 'a (3).jpg', 'raw/what_.cr2', 'raw__/notes', 'raw__/notes (2)',
  ]);
  assert.deepEqual(entryNames([{ path: '', name: 'x.tar.gz' }, { path: '', name: 'x.tar.gz' }], ''),
    ['x.tar.gz', 'x.tar (2).gz']);
  // A file named like a folder next to it is renamed, never the folder.
  assert.deepEqual(entryNames([{ path: '', name: 'Docs' }, { path: 'docs', name: 'x.txt' }], ''),
    ['Docs (2)', 'docs/x.txt']);
});
