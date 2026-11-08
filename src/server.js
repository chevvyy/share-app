'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { HttpError } = require('./errors');
const { setRef, redactIds } = require('./logger');
const { sanitizeFolderPath, comparePathName, MAX_PATH_DEPTH, MAX_PATH_CHARS } = require('./paths');
const { planZip, entryNames } = require('./zip');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Share links carry the ID in the URL fragment; never leak it via Referer.
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const JSON_BODY_LIMIT = 4096;
const SET_ROUTE = /^\/api\/sets\/([^/]+)$/;
const FILES_ROUTE = /^\/api\/sets\/([^/]+)\/files$/;
const FILE_ROUTE = /^\/api\/sets\/([^/]+)\/files\/([^/]+)$/;
const UPLOADS_ROUTE = /^\/api\/sets\/([^/]+)\/uploads$/;
const UPLOAD_ROUTE = /^\/api\/sets\/([^/]+)\/uploads\/([^/]+)$/;
const ARCHIVE_ROUTE = /^\/api\/sets\/([^/]+)\/archive$/;
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

function loadStaticAssets() {
  const assets = new Map();
  for (const [route, [file, type]] of Object.entries(STATIC_FILES)) {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    assets.set(route, { body, type, etag });
  }
  return assets;
}

// ------------------------------------------------------------------ helpers

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function methodNotAllowed(allowed) {
  return new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: allowed.join(', ') });
}

function setNotFound() {
  // Identical response for malformed, unknown, expired and deleted IDs: no oracle.
  return new HttpError(404, 'SET_NOT_FOUND', 'File set not found. It may have expired or been deleted.');
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must be JSON (Content-Type: application/json).');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > JSON_BODY_LIMIT) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

/**
 * Turn a client-supplied file name into a safe display name. Files are stored
 * under random IDs, so the name never touches the filesystem; this only keeps
 * the displayed and downloaded name sane (no paths, control or bidi characters).
 */
function sanitizeFileName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new HttpError(400, 'INVALID_FILE_NAME', 'A file name is required (query parameter "name").');
  }
  const name = raw
    .normalize('NFC')
    .split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (!name || name === '.' || name === '..') {
    throw new HttpError(400, 'INVALID_FILE_NAME', 'The file name is empty or invalid.');
  }
  if ([...name].length > 255) {
    throw new HttpError(400, 'INVALID_FILE_NAME', 'The file name is too long (maximum 255 characters).');
  }
  return name;
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Parse a single-range `Range` header. Returns null (serve whole file), a range, or 'unsatisfiable'. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // malformed or multi-range: ignore per RFC 9110
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return 'unsatisfiable';
  }
  return { start, end };
}

function requireContentLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) {
    throw new HttpError(411, 'LENGTH_REQUIRED',
      'Uploads must send a Content-Length header (chunked transfer encoding is not supported).');
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header.');
  }
  return Number(raw);
}

function parseSize(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'INVALID_SIZE', `"${field}" must be a non-negative whole number of bytes.`);
  }
  return value;
}

/** Write exactly `expected` bytes of the request body into the upload's temp file at `start`. */
async function streamBodyInto(req, upload, start, expected) {
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (got > expected) {
        cb(new HttpError(400, 'BODY_TOO_LONG', 'Request body is longer than its Content-Length.'));
        return;
      }
      upload.received = start + got;
      upload.crc = zlib.crc32(chunk, upload.crc);
      cb(null, chunk);
    },
  });
  await pipeline(req, counter, fs.createWriteStream(upload.tmpPath, { flags: 'r+', start }));
  if (got !== expected) {
    throw new HttpError(400, 'INCOMPLETE_UPLOAD', `Upload incomplete: received ${got} of ${expected} bytes.`);
  }
}

function setView(set, config) {
  const now = Date.now();
  return {
    id: set.id,
    createdAt: new Date(set.createdAt).toISOString(),
    expiresAt: new Date(set.expiresAt).toISOString(),
    serverTime: new Date(now).toISOString(),
    remainingSeconds: Math.max(0, Math.floor((set.expiresAt - now) / 1000)),
    usedBytes: set.usedBytes,
    reservedBytes: set.reservedBytes,
    maxBytes: config.maxSetBytes,
    maxFiles: config.maxFilesPerSet,
    files: [...set.files.values()]
      .sort((a, b) => a.uploadedAt - b.uploadedAt)
      .map((f) => fileView(f)),
  };
}

function fileView(file) {
  return {
    id: file.id, name: file.name, path: file.path, size: file.size, uploadedAt: new Date(file.uploadedAt).toISOString(),
  };
}

// ------------------------------------------------------------------ server

function createServer({ config, store, log, state }) {
  const assets = loadStaticAssets();

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
  }

  function getSet(id) {
    const set = store.get(id);
    if (!set) throw setNotFound();
    return set;
  }

  // ---- handlers

  async function handleCreateSet(req, res) {
    const body = await readJson(req);
    const ttl = body?.ttlSeconds;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl)) {
      throw new HttpError(400, 'INVALID_TTL', '"ttlSeconds" must be a whole number of seconds.');
    }
    const set = await store.create(ttl);
    sendJson(res, 201, setView(set, config));
  }

  /** Convert a failed body write into the right client-facing error. */
  function uploadFailure(err, req, ctx, set, upload) {
    if (set.deleted) {
      return new HttpError(410, 'SET_EXPIRED', 'The file set expired or was deleted during the upload.');
    }
    if (req.destroyed && !(err instanceof HttpError)) {
      log.info('upload aborted by client', {
        reqId: ctx.reqId, set: setRef(set.id), fileId: upload.id, received: upload.received, bytes: upload.length,
      });
      return new HttpError(400, 'UPLOAD_ABORTED', 'The upload was interrupted.');
    }
    return err;
  }

  async function commitAndRespond(res, set, upload) {
    try {
      const file = await store.commitUpload(upload);
      sendJson(res, 201, { file: fileView(file), set: setView(set, config) });
    } catch (err) {
      await store.abortUpload(upload);
      throw err;
    }
  }

  /** Single-request upload: the request body is the whole file. */
  async function handleUpload(req, res, ctx, set, url) {
    const name = sanitizeFileName(url.searchParams.get('name'));
    const folder = sanitizeFolderPath(url.searchParams.get('path'));
    const length = requireContentLength(req);

    // Reserves quota; throws 413/409/507 before we accept a single body byte.
    const upload = await store.beginUpload(set, name, length, { path: folder });
    upload.cancel = () => req.destroy();
    ctx.fileId = upload.id;
    if (req.expectsContinue) res.writeContinue();
    log.info('upload started', { reqId: ctx.reqId, set: setRef(set.id), fileId: upload.id, bytes: length });

    try {
      await streamBodyInto(req, upload, 0, length);
    } catch (err) {
      await store.abortUpload(upload);
      throw uploadFailure(err, req, ctx, set, upload);
    }
    await commitAndRespond(res, set, upload);
  }

  /** Start a chunked upload session; reserves the whole file size up front. */
  async function handleCreateUpload(req, res, ctx, set) {
    const body = await readJson(req);
    const name = sanitizeFileName(body?.name);
    const size = parseSize(body?.size, 'size');
    const folder = sanitizeFolderPath(body?.path);
    const upload = await store.beginUpload(set, name, size, { chunked: true, path: folder });
    ctx.fileId = upload.id;
    log.info('upload session started', { reqId: ctx.reqId, set: setRef(set.id), fileId: upload.id, bytes: size });
    if (size === 0) return commitAndRespond(res, set, upload);
    sendJson(res, 201, { uploadId: upload.id, size, received: 0, chunkBytes: config.chunkBytes });
  }

  /** Append one chunk at `?offset=N`. Chunks must arrive in order; a failed chunk is retried at the same offset. */
  async function handleChunk(req, res, ctx, set, uploadId, url) {
    const upload = store.getUpload(set, uploadId);
    if (!upload || !upload.chunked) {
      throw new HttpError(404, 'UPLOAD_NOT_FOUND', 'Upload not found. It may have finished, been cancelled, or timed out.');
    }
    ctx.fileId = upload.id;
    const length = requireContentLength(req);
    const rawOffset = url.searchParams.get('offset');
    if (rawOffset === null || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) {
      throw new HttpError(400, 'INVALID_OFFSET', 'Query parameter "offset" must be a non-negative integer.');
    }
    const offset = Number(rawOffset);
    if (upload.busy) {
      throw new HttpError(409, 'UPLOAD_BUSY', 'Another request is already writing to this upload.');
    }
    if (offset !== upload.received) {
      throw new HttpError(409, 'OFFSET_MISMATCH', `Expected the next chunk at offset ${upload.received}.`,
        {}, { expectedOffset: upload.received });
    }
    if (length === 0 || length > upload.length - offset) {
      throw new HttpError(400, 'INVALID_CHUNK',
        `Chunk must be between 1 and ${upload.length - offset} bytes at offset ${offset}.`);
    }

    upload.busy = true;
    upload.cancel = () => req.destroy();
    if (req.expectsContinue) res.writeContinue();
    const crcBefore = upload.crc;
    try {
      await streamBodyInto(req, upload, offset, length);
    } catch (err) {
      upload.received = offset; // discard the partial chunk; the client retries from the same offset
      upload.crc = crcBefore;
      throw uploadFailure(err, req, ctx, set, upload);
    } finally {
      upload.busy = false;
      upload.cancel = null;
      upload.lastActivity = Date.now();
    }
    if (upload.released) {
      // Cancelled (or swept) while this chunk was being written.
      throw new HttpError(404, 'UPLOAD_NOT_FOUND', 'Upload was cancelled.');
    }
    if (upload.received === upload.length) return commitAndRespond(res, set, upload);
    sendJson(res, 200, { uploadId: upload.id, size: upload.length, received: upload.received });
  }

  async function handleDownload(req, res, ctx, set, fileId) {
    const file = store.getFile(set, fileId);
    if (!file) throw new HttpError(404, 'FILE_NOT_FOUND', 'File not found.');
    const filePath = store.filePath(set, file);
    let fh;
    try {
      fh = await fsp.open(filePath, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'FILE_NOT_FOUND', 'File not found.');
      throw err;
    }
    let stream;
    try {
      const { size } = await fh.stat();
      const etag = `"${file.id}"`; // uploaded files are immutable, so the ID is a valid strong ETag
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.name),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        ETag: etag,
        'Last-Modified': new Date(file.uploadedAt).toUTCString(),
      };
      const ifRange = req.headers['if-range'];
      const range = (!ifRange || ifRange === etag) ? parseRange(req.headers.range, size) : null;
      if (range === 'unsatisfiable') {
        throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range not satisfiable.', {
          'Content-Range': `bytes */${size}`,
        });
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || size === 0) {
        res.end();
        return;
      }
      stream = fh.createReadStream({ start, end, autoClose: true });
      fh = null; // the stream owns the handle now
      set.downloads.add(stream);
      await pipeline(stream, res);
      log.info('file downloaded', {
        reqId: ctx.reqId, set: setRef(set.id), fileId: file.id, bytes: end - start + 1, partial: Boolean(range),
      });
    } catch (err) {
      if (res.headersSent && (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET')) {
        log.info('download aborted', { reqId: ctx.reqId, set: setRef(set.id), fileId: file.id });
        return;
      }
      throw err;
    } finally {
      if (stream) set.downloads.delete(stream);
      await fh?.close().catch(() => {});
    }
  }

  /** Stream one folder (`?path=P`) or the whole set as a stored ZIP with an exact Content-Length. */
  async function handleArchive(req, res, ctx, set, url) {
    const prefix = sanitizeFolderPath(url.searchParams.get('path'));
    // Committed files only: uploads still in progress are not in set.files.
    const files = [...set.files.values()]
      .filter((f) => !prefix || f.path === prefix || f.path.startsWith(`${prefix}/`))
      .sort(comparePathName);
    if (files.length === 0) {
      throw new HttpError(404, 'NOTHING_TO_ARCHIVE', 'There are no files in that folder.');
    }
    try {
      await store.ensureCrcs(set, files);
    } catch (err) {
      // A file deleted (or the set expiring) meanwhile; the raw error would log a path containing the set ID.
      if (err.code !== 'ENOENT') throw err;
      if (set.deleted) throw setNotFound();
      throw new HttpError(409, 'ARCHIVE_CHANGED', 'Files changed while the archive was being prepared. Please try again.');
    }
    if (set.deleted) throw setNotFound();

    const names = entryNames(files, prefix);
    const plan = planZip(files.map((f, i) => ({ name: names[i], size: f.size, crc32: f.crc32, mtime: f.uploadedAt })));
    const label = prefix ? prefix.slice(prefix.lastIndexOf('/') + 1) : 'share-files';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${label}.zip`),
      'Content-Length': plan.length,
      'Accept-Ranges': 'none',
      'Cache-Control': 'private, no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    async function* body() {
      for (const part of plan.parts) {
        if (part.buffer) {
          yield part.buffer;
          continue;
        }
        if (part.size === 0) continue;
        const file = files[part.index];
        let sent = 0;
        for await (const chunk of fs.createReadStream(store.filePath(set, file))) {
          sent += chunk.length;
          if (sent > part.size) break;
          yield chunk;
        }
        // A short or changed file would corrupt every offset after it: abort instead.
        if (sent !== part.size) throw new Error('archived file changed size while streaming');
      }
    }

    const stream = Readable.from(body(), { objectMode: false });
    set.downloads.add(stream); // expiry or delete destroys it, aborting the response
    try {
      await pipeline(stream, res);
      log.info('archive downloaded', {
        reqId: ctx.reqId, set: setRef(set.id), files: files.length, bytes: plan.length, zip64: plan.zip64,
      });
    } catch (err) {
      if (res.headersSent && (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET'
          || err.code === 'ENOENT' || set.deleted)) {
        log.info('archive download aborted', { reqId: ctx.reqId, set: setRef(set.id) });
        res.destroy();
        return;
      }
      throw err;
    } finally {
      set.downloads.delete(stream);
    }
  }

  async function handleReady(res) {
    if (!store.ready || state.shuttingDown) {
      sendJson(res, 503, { status: state.shuttingDown ? 'shutting-down' : 'starting' });
      return;
    }
    try {
      await fsp.access(store.setsDir, fs.constants.R_OK | fs.constants.W_OK);
      sendJson(res, 200, { status: 'ready' });
    } catch (err) {
      log.error('readiness check failed: data directory not writable', { err });
      sendJson(res, 503, { status: 'storage-unavailable' });
    }
  }

  function serveStatic(req, res, asset) {
    const headers = {
      'Content-Type': asset.type,
      'Cache-Control': 'no-cache',
      ETag: asset.etag,
    };
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  }

  // ---- router

  async function route(req, res, url, ctx) {
    const { method } = req;
    const p = url.pathname;
    let m;

    if (p === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(['GET', 'HEAD']);
      return sendJson(res, 200, { status: 'ok' });
    }
    if (p === '/readyz') {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(['GET', 'HEAD']);
      return handleReady(res);
    }
    if (p === '/api/config') {
      if (method !== 'GET') throw methodNotAllowed(['GET']);
      return sendJson(res, 200, {
        minTtlSeconds: config.minTtlSeconds,
        maxTtlSeconds: config.maxTtlSeconds,
        maxSetBytes: config.maxSetBytes,
        maxFilesPerSet: config.maxFilesPerSet,
        chunkBytes: config.chunkBytes,
        maxPathDepth: MAX_PATH_DEPTH,
        maxPathChars: MAX_PATH_CHARS,
        ...store.stats(),
      });
    }
    if (p === '/api/sets') {
      if (method !== 'POST') throw methodNotAllowed(['POST']);
      return handleCreateSet(req, res);
    }
    if ((m = SET_ROUTE.exec(p))) {
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      if (method === 'GET') return sendJson(res, 200, setView(set, config));
      if (method === 'DELETE') {
        await store.deleteSet(set, 'deleted-by-user');
        return sendNoContent(res);
      }
      throw methodNotAllowed(['GET', 'DELETE']);
    }
    if ((m = FILES_ROUTE.exec(p))) {
      if (method !== 'POST') throw methodNotAllowed(['POST']);
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      return handleUpload(req, res, ctx, set, url);
    }
    if ((m = FILE_ROUTE.exec(p))) {
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      if (method === 'GET' || method === 'HEAD') return handleDownload(req, res, ctx, set, m[2]);
      if (method === 'DELETE') {
        await store.deleteFile(set, m[2]);
        return sendNoContent(res);
      }
      throw methodNotAllowed(['GET', 'HEAD', 'DELETE']);
    }
    if ((m = UPLOADS_ROUTE.exec(p))) {
      if (method !== 'POST') throw methodNotAllowed(['POST']);
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      return handleCreateUpload(req, res, ctx, set);
    }
    if ((m = UPLOAD_ROUTE.exec(p))) {
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      if (method === 'PUT') return handleChunk(req, res, ctx, set, m[2], url);
      if (method === 'DELETE') {
        await store.cancelUpload(set, m[2]);
        return sendNoContent(res);
      }
      throw methodNotAllowed(['PUT', 'DELETE']);
    }
    if ((m = ARCHIVE_ROUTE.exec(p))) {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(['GET', 'HEAD']);
      const set = getSet(m[1]);
      ctx.set = setRef(set.id);
      return handleArchive(req, res, ctx, set, url);
    }
    const asset = assets.get(p);
    if (asset) {
      if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(['GET', 'HEAD']);
      return serveStatic(req, res, asset);
    }
    throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  }

  function sendError(req, res, err, ctx) {
    const known = err instanceof HttpError;
    const status = known ? err.status : 500;
    ctx.errorCode = known ? err.code : 'INTERNAL_ERROR';
    if (!known) log.error('unhandled error while processing request', { reqId: ctx.reqId, err });
    if (res.headersSent || res.destroyed || req.socket.destroyed) {
      res.destroy();
      return;
    }
    const headers = { ...(known ? err.headers : {}) };
    // If the request body was not consumed (e.g. a rejected 5 GB upload), close
    // the connection instead of reading and discarding the rest of it.
    if (!req.complete) headers.Connection = 'close';
    sendJson(res, status, {
      error: {
        code: ctx.errorCode,
        message: known ? err.message : 'Internal server error.',
        requestId: ctx.reqId,
        ...(known ? err.details : {}),
      },
    }, headers);
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const ctx = { reqId: crypto.randomUUID() };
    res.setHeader('X-Request-Id', ctx.reqId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = null;
    }
    const logPath = url ? redactIds(url.pathname) : '(unparseable)';

    res.on('close', () => {
      const fields = {
        reqId: ctx.reqId,
        method: req.method,
        path: logPath,
        // 499 = connection closed before any response was sent (nginx convention)
        status: res.headersSent ? res.statusCode : 499,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        ip: clientIp(req),
        ...(ctx.set ? { set: ctx.set } : {}),
        ...(ctx.fileId ? { fileId: ctx.fileId } : {}),
        ...(ctx.errorCode ? { error: ctx.errorCode } : {}),
        ...(res.writableFinished ? {} : { aborted: true }),
      };
      if (url && QUIET_PATHS.has(url.pathname) && res.statusCode < 400) log.debug('request', fields);
      else log.info('request', fields);
    });

    try {
      if (!url) throw new HttpError(400, 'BAD_REQUEST', 'Malformed request URL.');
      // Upload bodies defer "100 Continue" until their checks pass.
      const isUploadBody = (req.method === 'POST' && FILES_ROUTE.test(url.pathname))
        || (req.method === 'PUT' && UPLOAD_ROUTE.test(url.pathname));
      if (req.expectsContinue && !isUploadBody) res.writeContinue();
      await route(req, res, url, ctx);
    } catch (err) {
      sendError(req, res, err, ctx);
    }
  }

  const server = http.createServer({
    requestTimeout: 0,         // no absolute cap: a 5 GB upload can take a long time
    headersTimeout: 30_000,    // ...but headers must arrive promptly
    keepAliveTimeout: 95_000,  // longer than Traefik's 90 s idle pool timeout, avoiding stale-connection 502s
  }, (req, res) => { handle(req, res); });

  server.on('checkContinue', (req, res) => {
    req.expectsContinue = true;
    handle(req, res);
  });
  // Abort transfers that stall (no bytes in either direction) for too long.
  server.timeout = config.idleTimeoutSeconds * 1000;
  server.on('timeout', (socket) => {
    log.info('closing idle connection', { ip: socket.remoteAddress });
    socket.destroy();
  });
  server.on('clientError', (err, socket) => {
    log.debug('client error', { err });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

module.exports = { createServer, sanitizeFileName, sanitizeFolderPath, parseRange, contentDisposition };
