'use strict';

// End-to-end tests: start the real server as a child process with tiny limits.
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'));
const ENV = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  DATA_DIR,
  MAX_SETS: '3',
  MAX_SET_BYTES: '1000',
  MIN_TTL_SECONDS: '1',
  SWEEP_INTERVAL_SECONDS: '1',
  DISK_RESERVE_BYTES: '0',
  UPLOAD_SESSION_IDLE_SECONDS: '2',
  LOG_LEVEL: 'warn',
};

let child;

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env: ENV, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not become ready');
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
}

const json = async (method, url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

const createSet = (ttlSeconds = 600) => json('POST', '/api/sets', { ttlSeconds });

const upload = async (id, name, data, folder) => {
  const q = folder === undefined ? '' : `&path=${encodeURIComponent(folder)}`;
  const res = await fetch(`${BASE}/api/sets/${id}/files?name=${encodeURIComponent(name)}${q}`, { method: 'POST', body: data });
  return { status: res.status, body: await res.json() };
};

/** Parse a ZIP by walking its central directory (handles ZIP64). Returns [{name, size, crc32, data, flags}]. */
function parseZip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'end of central directory record');
  let count = buf.readUInt16LE(end + 10);
  let cdOffset = buf.readUInt32LE(end + 16);
  if (buf.readUInt32LE(end - 20) === 0x07064b50) {
    const rec = Number(buf.readBigUInt64LE(end - 20 + 8));
    assert.equal(buf.readUInt32LE(rec), 0x06064b50);
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(method, 0, 'stored');
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    entries.push({ name, size, crc32, flags, data: buf.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const getArchive = async (id, folder) => {
  const q = folder === undefined ? '' : `?path=${encodeURIComponent(folder)}`;
  const res = await fetch(`${BASE}/api/sets/${id}/archive${q}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
};

const deleteAll = async () => {
  for (const dir of fs.readdirSync(path.join(DATA_DIR, 'sets'))) {
    await fetch(`${BASE}/api/sets/${dir}`, { method: 'DELETE' });
  }
};

before(startServer);
after(async () => {
  await stopServer();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('creates a set with a 43-char random ID and enforces TTL bounds', async () => {
  const a = await createSet(60);
  assert.equal(a.status, 201);
  assert.match(a.body.id, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(a.body.remainingSeconds > 55 && a.body.remainingSeconds <= 60);

  assert.equal((await createSet(6 * 3600 + 1)).status, 400);
  assert.equal((await createSet(0)).status, 400);
  assert.equal((await createSet(1.5)).status, 400);
  assert.equal((await json('POST', '/api/sets', { ttlSeconds: '60' })).status, 400);
  const notJson = await fetch(`${BASE}/api/sets`, { method: 'POST', body: '{}' });
  assert.equal(notJson.status, 415);
  await deleteAll();
});

test('round-trips a file and serves it as a safe attachment', async () => {
  const { body: set } = await createSet();
  const data = Buffer.from('hello, world\n');
  const up = await upload(set.id, 'grüße "x".txt', data);
  assert.equal(up.status, 201);
  assert.equal(up.body.file.size, data.length);
  assert.equal(up.body.set.usedBytes, data.length);

  const res = await fetch(`${BASE}/api/sets/${set.id}/files/${up.body.file.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="gr__e _x_.txt"; filename\*=UTF-8''gr%C3%BC%C3%9Fe%20%22x%22.txt$/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
  await deleteAll();
});

test('supports byte-range downloads', async () => {
  const { body: set } = await createSet();
  const up = await upload(set.id, 'r.bin', Buffer.from('0123456789'));
  const url = `${BASE}/api/sets/${set.id}/files/${up.body.file.id}`;
  let res = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await res.text(), '2345');
  res = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(await res.text(), '789');
  res = await fetch(url, { headers: { Range: 'bytes=50-' } });
  assert.equal(res.status, 416);
  await deleteAll();
});

test('enforces the per-set byte cap across multiple uploads', async () => {
  const { body: set } = await createSet();
  assert.equal((await upload(set.id, 'a', Buffer.alloc(600))).status, 201);
  const tooBig = await upload(set.id, 'b', Buffer.alloc(401));
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, 'SET_QUOTA_EXCEEDED');
  assert.match(tooBig.body.error.message, /400 B left/);
  assert.equal((await upload(set.id, 'c', Buffer.alloc(400))).status, 201);
  assert.equal((await upload(set.id, 'd', Buffer.alloc(1))).status, 413);
  const info = await json('GET', `/api/sets/${set.id}`);
  assert.equal(info.body.usedBytes, 1000);
  assert.equal(info.body.files.length, 2);
  await deleteAll();
});

test('enforces the per-set cap for concurrent uploads via reservations', async () => {
  const { body: set } = await createSet();
  const results = await Promise.all([1, 2, 3].map((n) => upload(set.id, `p${n}`, Buffer.alloc(400))));
  const ok = results.filter((r) => r.status === 201).length;
  assert.equal(ok, 2);
  assert.equal(results.filter((r) => r.status === 413).length, 1);
  assert.equal((await json('GET', `/api/sets/${set.id}`)).body.usedBytes, 800);
  await deleteAll();
});

test('deleting a file frees its quota', async () => {
  const { body: set } = await createSet();
  const up = await upload(set.id, 'a', Buffer.alloc(900));
  assert.equal((await upload(set.id, 'b', Buffer.alloc(200))).status, 413);
  const del = await fetch(`${BASE}/api/sets/${set.id}/files/${up.body.file.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await upload(set.id, 'b', Buffer.alloc(200))).status, 201);
  await deleteAll();
});

test('enforces the maximum number of concurrent sets', async () => {
  for (let i = 0; i < 3; i += 1) assert.equal((await createSet()).status, 201);
  const fourth = await createSet();
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'SET_LIMIT_REACHED');
  assert.ok(Number(fourth.headers.get('retry-after')) > 0);
  await deleteAll();
  assert.equal((await createSet()).status, 201);
  await deleteAll();
});

test('concurrent creates cannot exceed the set limit', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => createSet()));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  await deleteAll();
});

test('expired sets are deleted from disk by the background sweeper', async () => {
  const { body: set } = await createSet(1);
  await upload(set.id, 'x', Buffer.from('bye'));
  const dir = path.join(DATA_DIR, 'sets', set.id);
  assert.ok(fs.existsSync(dir));
  // No requests in between: deletion must not depend on anyone visiting.
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(fs.existsSync(dir), false);
  assert.equal((await json('GET', `/api/sets/${set.id}`)).status, 404);
});

test('rejects bad IDs, bad names and uploads without Content-Length', async () => {
  assert.equal((await json('GET', '/api/sets/nope')).status, 404);
  assert.equal((await json('GET', `/api/sets/${'a'.repeat(43)}`)).status, 404);
  const { body: set } = await createSet();

  const traversal = await upload(set.id, '../../etc/passwd', Buffer.from('x'));
  assert.equal(traversal.status, 201);
  assert.equal(traversal.body.file.name, 'passwd');
  assert.equal((await upload(set.id, '..', Buffer.from('x'))).status, 400);
  assert.equal((await upload(set.id, '', Buffer.from('x'))).status, 400);

  // Chunked request without Content-Length -> 411
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/sets/${set.id}/files?name=c`, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('abc');
    req.end();
  });
  assert.equal(status, 411);
  await deleteAll();
});

test('rejects an oversized upload before reading its body (Expect: 100-continue)', async () => {
  const { body: set } = await createSet();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/sets/${set.id}/files?name=big`, {
      method: 'POST', headers: { 'Content-Length': '5000000000', Expect: '100-continue' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('continue', () => reject(new Error('server sent 100 Continue for an over-quota upload')));
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(status, 413);
  await deleteAll();
});

test('a client that disconnects mid-upload releases its reservation and leaves no temp file', async () => {
  const { body: set } = await createSet();
  await new Promise((resolve) => {
    const req = http.request(`${BASE}/api/sets/${set.id}/files?name=partial`, { method: 'POST', headers: { 'Content-Length': '900' } });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(100));
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((r) => setTimeout(r, 200));
  const info = await json('GET', `/api/sets/${set.id}`);
  assert.equal(info.body.reservedBytes, 0);
  assert.equal(info.body.files.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'sets', set.id, 'tmp')), []);
  await deleteAll();
});

const putChunk = async (id, uploadId, offset, data) => {
  const res = await fetch(`${BASE}/api/sets/${id}/uploads/${uploadId}?offset=${offset}`, { method: 'PUT', body: data });
  return { status: res.status, body: await res.json() };
};

test('chunked upload: reserves full size, resumes after offset mismatch, commits on last chunk', async () => {
  const { body: set } = await createSet();
  const data = Buffer.from('abcdefghijklmnopqrstuvwxyz'.repeat(20)); // 520 bytes
  const s = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'big.txt', size: data.length });
  assert.equal(s.status, 201);
  const { uploadId } = s.body;

  // The whole size is reserved up front: a competing 500-byte upload must not fit.
  assert.equal((await upload(set.id, 'other', Buffer.alloc(500))).status, 413);

  assert.deepEqual((await putChunk(set.id, uploadId, 0, data.subarray(0, 200))).body.received, 200);
  // Wrong offset -> 409 tells the client where to resume.
  const mismatch = await putChunk(set.id, uploadId, 0, data.subarray(0, 200));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.expectedOffset, 200);
  // Chunk overrunning the declared size -> 400.
  assert.equal((await putChunk(set.id, uploadId, 200, Buffer.alloc(400))).status, 400);
  assert.equal((await putChunk(set.id, uploadId, 200, data.subarray(200, 400))).status, 200);
  const done = await putChunk(set.id, uploadId, 400, data.subarray(400));
  assert.equal(done.status, 201);
  assert.equal(done.body.file.id, uploadId);
  assert.equal(done.body.set.usedBytes, 520);
  assert.equal(done.body.set.reservedBytes, 0);

  const res = await fetch(`${BASE}/api/sets/${set.id}/files/${uploadId}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
  // Session is gone after commit.
  assert.equal((await putChunk(set.id, uploadId, 520, Buffer.alloc(1))).status, 404);
  await deleteAll();
});

test('chunked upload: rejects sessions over quota; cancel and idle timeout release reservations', async () => {
  const { body: set } = await createSet();
  const over = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'x', size: 1001 });
  assert.equal(over.status, 413);
  assert.equal((await json('POST', `/api/sets/${set.id}/uploads`, { name: 'x', size: -1 })).status, 400);

  const a = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'a', size: 600 });
  const del = await fetch(`${BASE}/api/sets/${set.id}/uploads/${a.body.uploadId}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await json('GET', `/api/sets/${set.id}`)).body.reservedBytes, 0);

  const b = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'b', size: 600 });
  await putChunk(set.id, b.body.uploadId, 0, Buffer.alloc(100));
  assert.equal((await json('GET', `/api/sets/${set.id}`)).body.reservedBytes, 600);
  await new Promise((r) => setTimeout(r, 3600)); // idle timeout 2 s + sweep interval 1 s
  assert.equal((await json('GET', `/api/sets/${set.id}`)).body.reservedBytes, 0);
  assert.equal((await putChunk(set.id, b.body.uploadId, 100, Buffer.alloc(100))).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'sets', set.id, 'tmp')), []);

  const empty = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'empty', size: 0 });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.file.size, 0);
  await deleteAll();
});

test('sets and files survive a restart, with folder paths and CRCs', async () => {
  const { body: set } = await createSet();
  const up = await upload(set.id, 'keep.txt', Buffer.from('persist me'));
  const nested = await upload(set.id, 'deep.txt', Buffer.from('nested'), 'Docs/2026');
  await stopServer();
  await startServer();
  const info = await json('GET', `/api/sets/${set.id}`);
  assert.equal(info.status, 200);
  const byName = Object.fromEntries(info.body.files.map((f) => [f.name, f]));
  assert.equal(byName['keep.txt'].path, '');
  assert.equal(byName['deep.txt'].path, 'Docs/2026');
  assert.equal(info.body.expiresAt, set.expiresAt);
  const res = await fetch(`${BASE}/api/sets/${set.id}/files/${up.body.file.id}`);
  assert.equal(await res.text(), 'persist me');
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets', set.id, 'meta.json'), 'utf8'));
  const deep = meta.files.find((f) => f.id === nested.body.file.id);
  assert.equal(deep.path, 'Docs/2026');
  assert.equal(deep.crc32, zlib.crc32(Buffer.from('nested')));
  await deleteAll();
});

test('metadata from 1.0.0 (no path, no crc32) loads; archive computes and saves the CRC', async () => {
  const { body: set } = await createSet();
  const up = await upload(set.id, 'old.txt', Buffer.from('from before folders'));
  await stopServer();
  const metaPath = path.join(DATA_DIR, 'sets', set.id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.files = meta.files.map(({ id, name, size, uploadedAt }) => ({ id, name, size, uploadedAt }));
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  await startServer();

  const info = await json('GET', `/api/sets/${set.id}`);
  assert.equal(info.body.files[0].path, '');
  const zip = await getArchive(set.id);
  assert.equal(zip.status, 200);
  const [entry] = parseZip(zip.buf);
  assert.equal(entry.name, 'old.txt');
  assert.equal(entry.crc32, zlib.crc32(Buffer.from('from before folders')));
  const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8')).files.find((f) => f.id === up.body.file.id);
  assert.equal(saved.crc32, entry.crc32);
  await deleteAll();
});

test('upload with a folder path round-trips', async () => {
  const { body: set } = await createSet();
  const up = await upload(set.id, 'photo.jpg', Buffer.from('jpeg bytes'), 'Vacation\\2026/raw/');
  assert.equal(up.status, 201);
  assert.equal(up.body.file.path, 'Vacation/2026/raw');
  const plain = await upload(set.id, 'top.txt', Buffer.from('top'));
  assert.equal(plain.body.file.path, '');
  const info = await json('GET', `/api/sets/${set.id}`);
  assert.equal(info.body.files.find((f) => f.id === up.body.file.id).path, 'Vacation/2026/raw');
  const res = await fetch(`${BASE}/api/sets/${set.id}/files/${up.body.file.id}`);
  assert.equal(await res.text(), 'jpeg bytes');
  const cfg = await json('GET', '/api/config');
  assert.equal(cfg.body.maxPathDepth, 32);
  assert.equal(cfg.body.maxPathChars, 1024);
  await deleteAll();
});

test('invalid folder paths are rejected with 400 INVALID_PATH', async () => {
  const { body: set } = await createSet();
  const seg204 = 'a'.repeat(204);
  const bad = [
    '../x', 'a/../b', '/abs', 'C:/x', 'a//b', '.', 'a/\u0007b',
    Array.from({ length: 33 }, () => 'd').join('/'),
    [seg204, seg204, seg204, seg204, seg204].join('/') + 'b', // 1025 characters
    'x'.repeat(256),
  ];
  assert.equal(bad[8].length, 1025);
  for (const p of bad) {
    const r = await upload(set.id, 'f.txt', Buffer.from('x'), p);
    assert.equal(r.status, 400, `path ${JSON.stringify(p.slice(0, 40))}`);
    assert.equal(r.body.error.code, 'INVALID_PATH');
  }
  const chunked = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'f', size: 10, path: '../up' });
  assert.equal(chunked.status, 400);
  assert.equal(chunked.body.error.code, 'INVALID_PATH');
  const wrongType = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'f', size: 10, path: 5 });
  assert.equal(wrongType.body.error.code, 'INVALID_PATH');
  assert.equal((await json('GET', `/api/sets/${set.id}`)).body.reservedBytes, 0);
  await deleteAll();
});

test('chunked upload with a path: a failed chunk is retried and the CRC is still right', async () => {
  const { body: set } = await createSet();
  const data = Buffer.from('0123456789ABCDEFGHIJ'.repeat(15)); // 300 bytes
  const s = await json('POST', `/api/sets/${set.id}/uploads`, { name: 'c.bin', size: data.length, path: 'Big/parts' });
  assert.equal(s.status, 201);
  const { uploadId } = s.body;
  assert.equal((await putChunk(set.id, uploadId, 0, data.subarray(0, 100))).status, 200);

  // A chunk that dies half-way, carrying different bytes than the real data.
  await new Promise((resolve) => {
    const req = http.request(`${BASE}/api/sets/${set.id}/uploads/${uploadId}?offset=100`,
      { method: 'PUT', headers: { 'Content-Length': '100' } });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(60, 0xee));
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((r) => setTimeout(r, 200));
  const mismatch = await putChunk(set.id, uploadId, 160, data.subarray(160, 200));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.expectedOffset, 100);

  assert.equal((await putChunk(set.id, uploadId, 100, data.subarray(100, 200))).status, 200);
  const done = await putChunk(set.id, uploadId, 200, data.subarray(200));
  assert.equal(done.status, 201);
  assert.equal(done.body.file.path, 'Big/parts');

  const zip = await getArchive(set.id, 'Big');
  const [entry] = parseZip(zip.buf);
  assert.equal(entry.name, 'parts/c.bin');
  assert.deepEqual(Buffer.from(entry.data), data);
  assert.equal(entry.crc32, zlib.crc32(data));
  await deleteAll();
});

test('archive of the whole set and of one folder: names, sizes, CRCs, HEAD length, 404, duplicates', async () => {
  const { body: set } = await createSet();
  const files = [
    ['', 'readme.txt', 'top level'],
    ['Trip', 'a.txt', 'alpha'],
    ['Trip', 'a.txt', 'alpha again'],
    ['Trip/raw', 'b.bin', 'bravo bytes'],
    ['Trip/raw', 'empty', ''],
    ['Other', 'grüße.txt', 'unicode'],
    ['Trip 2', 'c.txt', 'not inside Trip'],
  ];
  for (const [folder, name, text] of files) {
    assert.equal((await upload(set.id, name, Buffer.from(text), folder)).status, 201);
  }

  const all = await getArchive(set.id);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-type'), 'application/zip');
  assert.equal(all.headers.get('accept-ranges'), 'none');
  assert.equal(all.headers.get('cache-control'), 'private, no-store');
  assert.match(all.headers.get('content-disposition'), /^attachment; filename="share-files\.zip"/);
  assert.equal(Number(all.headers.get('content-length')), all.buf.length);
  const entries = parseZip(all.buf);
  assert.deepEqual(entries.map((e) => e.name), [
    'readme.txt', 'Other/grüße.txt', 'Trip/a.txt', 'Trip/a (2).txt', 'Trip/raw/b.bin', 'Trip/raw/empty', 'Trip 2/c.txt',
  ]);
  for (const e of entries) {
    assert.equal(e.flags & 0x0800, 0x0800, 'UTF-8 flag');
    assert.equal(e.size, e.data.length);
    assert.equal(e.crc32, zlib.crc32(e.data));
  }
  assert.deepEqual(entries.map((e) => e.data.toString()).sort(), files.map((f) => f[2]).sort());

  const trip = await getArchive(set.id, 'Trip');
  assert.match(trip.headers.get('content-disposition'), /filename="Trip\.zip"/);
  assert.deepEqual(parseZip(trip.buf).map((e) => e.name), ['a.txt', 'a (2).txt', 'raw/b.bin', 'raw/empty']);
  const raw = await getArchive(set.id, 'Trip/raw');
  assert.match(raw.headers.get('content-disposition'), /filename="raw\.zip"/);
  assert.deepEqual(parseZip(raw.buf).map((e) => e.name), ['b.bin', 'empty']);

  const head = await fetch(`${BASE}/api/sets/${set.id}/archive?path=Trip`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), trip.buf.length);

  const none = await getArchive(set.id, 'Tri');
  assert.equal(none.status, 404);
  assert.equal(JSON.parse(none.buf).error.code, 'NOTHING_TO_ARCHIVE');
  assert.equal((await getArchive(set.id, '../Trip')).status, 400);
  assert.equal((await fetch(`${BASE}/api/sets/${set.id}/archive`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${BASE}/api/sets/${'a'.repeat(43)}/archive`)).status, 404);

  // If unzip is on this machine, let it check the archive too.
  const { spawnSync } = require('node:child_process');
  const zipPath = path.join(os.tmpdir(), `share-test-${process.pid}.zip`);
  fs.writeFileSync(zipPath, all.buf);
  const check = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
  fs.rmSync(zipPath, { force: true });
  if (!check.error) assert.equal(check.status, 0, check.stdout + check.stderr);
  await deleteAll();
});

test('a set that expires mid-archive aborts the stream and leaves nothing behind', async () => {
  // A second server with room for a file big enough that the archive cannot sit in socket buffers.
  const port = PORT + 1000;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-big-'));
  const big = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...ENV, PORT: String(port), DATA_DIR: dataDir, MAX_SET_BYTES: String(64 * 1024 ** 2) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`${base}/readyz`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const set = await (await fetch(`${base}/api/sets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlSeconds: 3 }),
    })).json();
    const payload = Buffer.alloc(40 * 1024 ** 2, 7);
    const up = await fetch(`${base}/api/sets/${set.id}/files?name=big.bin&path=Big`, { method: 'POST', body: payload });
    assert.equal(up.status, 201);

    const { expected, received } = await new Promise((resolve, reject) => {
      http.get(`${base}/api/sets/${set.id}/archive`, (res) => {
        const total = Number(res.headers['content-length']);
        res.pause(); // stall the download until the set expires
        setTimeout(() => {
          let got = 0;
          const finish = () => resolve({ expected: total, received: got });
          res.on('data', (c) => { got += c.length; });
          res.on('end', finish);
          res.on('error', finish);
          res.on('close', finish);
          res.resume();
        }, 4500);
      }).on('error', reject);
    });
    assert.ok(received < expected, `stream should be cut short (got ${received} of ${expected})`);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'sets')), []);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    const exited = new Promise((r) => big.once('exit', r));
    big.kill('SIGTERM');
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('serves the UI with security headers', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await res.text(), /<title>Share/);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/sets`, { method: 'GET' })).status, 405);
});
