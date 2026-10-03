'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError } = require('./errors');
const { setRef } = require('./logger');
const { formatBytes, formatDuration } = require('./format');

// 32 random bytes = 256 bits of entropy, base64url-encoded to 43 characters.
const SET_ID_BYTES = 32;
const SET_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const META_VERSION = 1;

const newSetId = () => crypto.randomBytes(SET_ID_BYTES).toString('base64url');
const newFileId = () => crypto.randomBytes(16).toString('base64url');

const isValidSetId = (id) => typeof id === 'string' && SET_ID_RE.test(id);
const isValidFileId = (id) => typeof id === 'string' && FILE_ID_RE.test(id);

/**
 * Owns all file-set state. In-memory state is authoritative while running and
 * is persisted to `<dataDir>/sets/<id>/meta.json`, so it survives restarts.
 *
 * Disk layout:
 *   sets/<setId>/meta.json        set metadata + file list
 *   sets/<setId>/files/<fileId>   committed file contents
 *   sets/<setId>/tmp/<fileId>     in-flight uploads (discarded on restart)
 *
 * Uploads are either single-request (the whole file is one request body) or
 * chunked sessions (the browser sends sequential pieces, so a proxy body limit
 * such as Cloudflare's 100 MB never applies to the whole file). Both reserve
 * the full file size against the set's quota before any data is accepted.
 *
 * The app runs as a single replica, and Node runs it on one thread, so all
 * checks followed by synchronous reservations below are race-free.
 */
class SetStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.setsDir = path.join(config.dataDir, 'sets');
    /** @type {Map<string, object>} */
    this.sets = new Map();
    this.sweepTimer = null;
    this.sweeping = false;
    this.ready = false;
  }

  setDir(id) { return path.join(this.setsDir, id); }
  filesDir(id) { return path.join(this.setsDir, id, 'files'); }
  tmpDir(id) { return path.join(this.setsDir, id, 'tmp'); }
  filePath(set, file) { return path.join(this.filesDir(set.id), file.id); }

  newRecord(id, createdAt, expiresAt) {
    return {
      id,
      createdAt,
      expiresAt,
      files: new Map(),
      usedBytes: 0,      // bytes of committed files
      reservedBytes: 0,  // bytes promised to in-flight uploads
      uploads: new Map(), // uploadId -> in-flight upload
      downloads: new Set(),
      deleted: false,
      metaChain: Promise.resolve(),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await fsp.mkdir(this.setsDir, { recursive: true });
    const entries = await fsp.readdir(this.setsDir, { withFileTypes: true });
    for (const ent of entries) {
      const dir = path.join(this.setsDir, ent.name);
      if (!ent.isDirectory() || !isValidSetId(ent.name)) {
        this.log.warn('removing unexpected entry from data directory', { entry: ent.name });
        await fsp.rm(dir, { recursive: true, force: true });
        continue;
      }
      try {
        const set = await this.loadSet(ent.name);
        if (set) this.sets.set(set.id, set);
      } catch (err) {
        this.log.error('could not load file set from disk; removing it', { set: setRef(ent.name), err });
        await fsp.rm(dir, { recursive: true, force: true }).catch((rmErr) =>
          this.log.error('failed to remove unreadable file set', { set: setRef(ent.name), err: rmErr }));
      }
    }
    this.ready = true;
    this.log.info('store initialised', {
      dataDir: this.config.dataDir,
      sets: this.sets.size,
      usedBytes: [...this.sets.values()].reduce((n, s) => n + s.usedBytes, 0),
    });
    await this.sweep();
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => this.log.error('expiry sweep failed', { err }));
    }, this.config.sweepIntervalSeconds * 1000);
    this.sweepTimer.unref();
  }

  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Load one set from disk and reconcile its metadata with the files actually present. */
  async loadSet(id) {
    const dir = this.setDir(id);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (meta?.version !== META_VERSION || meta.id !== id
        || !Number.isFinite(meta.createdAt) || !Number.isFinite(meta.expiresAt)
        || !Array.isArray(meta.files)) {
      throw new Error('invalid meta.json');
    }
    if (meta.expiresAt <= Date.now()) {
      await fsp.rm(dir, { recursive: true, force: true });
      this.log.info('file set deleted', { set: setRef(id), reason: 'expired-while-offline' });
      return null;
    }

    // Uploads that were in flight when the process stopped can never complete.
    await fsp.rm(this.tmpDir(id), { recursive: true, force: true });
    await fsp.mkdir(this.tmpDir(id), { recursive: true });
    await fsp.mkdir(this.filesDir(id), { recursive: true });

    const set = this.newRecord(id, meta.createdAt, meta.expiresAt);
    const onDisk = new Set(await fsp.readdir(this.filesDir(id)));
    for (const f of meta.files) {
      if (!f || !isValidFileId(f.id) || typeof f.name !== 'string' || !onDisk.has(f.id)) {
        this.log.warn('dropping file entry with missing or invalid data', { set: setRef(id), fileId: f?.id });
        continue;
      }
      const st = await fsp.stat(path.join(this.filesDir(id), f.id));
      set.files.set(f.id, { id: f.id, name: f.name, size: st.size, uploadedAt: f.uploadedAt });
      set.usedBytes += st.size;
      onDisk.delete(f.id);
    }
    for (const orphan of onDisk) {
      this.log.warn('removing orphaned file not referenced by metadata', { set: setRef(id), file: orphan });
      await fsp.rm(path.join(this.filesDir(id), orphan), { recursive: true, force: true });
    }
    await this.persist(set);
    return set;
  }

  /** Serialised, atomic (write temp + rename) metadata write for one set. */
  persist(set) {
    const run = async () => {
      if (set.deleted) return;
      const meta = {
        version: META_VERSION,
        id: set.id,
        createdAt: set.createdAt,
        expiresAt: set.expiresAt,
        files: [...set.files.values()],
      };
      const dest = path.join(this.setDir(set.id), 'meta.json');
      const tmp = `${dest}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(meta));
        await fsp.rename(tmp, dest);
      } catch (err) {
        if (set.deleted) return; // directory was removed underneath us; nothing to save
        throw err;
      }
    };
    const p = set.metaChain.then(run, run);
    set.metaChain = p.catch(() => {});
    return p;
  }

  // -------------------------------------------------------------------- sets

  activeSets(now = Date.now()) {
    return [...this.sets.values()].filter((s) => !s.deleted && s.expiresAt > now);
  }

  stats() {
    return { activeSets: this.activeSets().length, maxSets: this.config.maxSets };
  }

  async create(ttlSeconds) {
    const { maxSets, minTtlSeconds, maxTtlSeconds } = this.config;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < minTtlSeconds || ttlSeconds > maxTtlSeconds) {
      throw new HttpError(400, 'INVALID_TTL',
        `Time until deletion must be between ${formatDuration(minTtlSeconds)} and ${formatDuration(maxTtlSeconds)}.`);
    }
    const now = Date.now();
    const active = this.activeSets(now);
    if (active.length >= maxSets) {
      const soonest = Math.min(...active.map((s) => s.expiresAt));
      const waitSeconds = Math.max(1, Math.ceil((soonest - now) / 1000));
      throw new HttpError(409, 'SET_LIMIT_REACHED',
        `The server already holds the maximum of ${maxSets} file sets. `
        + `The next one is deleted in about ${formatDuration(waitSeconds)}; please try again then.`,
        { 'Retry-After': String(waitSeconds) });
    }

    let id = newSetId();
    while (this.sets.has(id)) id = newSetId(); // astronomically unlikely, but free to check

    // Insert before any await so concurrent requests see the slot as taken.
    const set = this.newRecord(id, now, now + ttlSeconds * 1000);
    this.sets.set(id, set);
    try {
      await fsp.mkdir(this.filesDir(id), { recursive: true });
      await fsp.mkdir(this.tmpDir(id), { recursive: true });
      await this.persist(set);
    } catch (err) {
      this.sets.delete(id);
      set.deleted = true;
      await fsp.rm(this.setDir(id), { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    this.log.info('file set created', {
      set: setRef(id), ttlSeconds, expiresAt: new Date(set.expiresAt).toISOString(),
      activeSets: active.length + 1,
    });
    return set;
  }

  /** Look up a live set. Unknown, malformed, expired and deleted IDs all return null. */
  get(id) {
    if (!isValidSetId(id)) return null;
    const set = this.sets.get(id);
    if (!set || set.deleted) return null;
    if (set.expiresAt <= Date.now()) {
      this.deleteSet(set, 'expired').catch((err) =>
        this.log.error('failed to delete expired file set', { set: setRef(id), err }));
      return null;
    }
    return set;
  }

  async deleteSet(set, reason) {
    if (set.deleted) return;
    set.deleted = true;
    this.sets.delete(set.id);
    const cancelled = set.uploads.size;
    for (const upload of set.uploads.values()) upload.cancel?.();
    for (const stream of set.downloads) stream.destroy();
    await set.metaChain;
    await fsp.rm(this.setDir(set.id), { recursive: true, force: true, maxRetries: 3 });
    this.log.info('file set deleted', {
      set: setRef(set.id), reason, files: set.files.size, bytes: set.usedBytes, cancelledUploads: cancelled,
    });
  }

  /**
   * Deletes expired sets, plus any directory on disk that is not a known set
   * (e.g. a previous delete that failed half-way). Runs on a timer, so expiry
   * never depends on anyone visiting the site.
   */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const set of [...this.sets.values()]) {
        if (set.expiresAt <= now) {
          await this.deleteSet(set, 'expired').catch((err) =>
            this.log.error('failed to delete expired file set', { set: setRef(set.id), err }));
        }
      }
      for (const set of this.sets.values()) {
        for (const upload of [...set.uploads.values()]) {
          if (upload.chunked && !upload.busy
              && now - upload.lastActivity > this.config.uploadSessionIdleSeconds * 1000) {
            this.log.info('discarding abandoned upload session', {
              set: setRef(set.id), fileId: upload.id, received: upload.received, bytes: upload.length,
            });
            await this.abortUpload(upload);
          }
        }
      }
      for (const name of await fsp.readdir(this.setsDir)) {
        if (!this.sets.has(name)) {
          this.log.warn('removing stray directory left in data directory', { entry: isValidSetId(name) ? setRef(name) : name });
          await fsp.rm(path.join(this.setsDir, name), { recursive: true, force: true }).catch((err) =>
            this.log.error('failed to remove stray directory', { err }));
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  // ------------------------------------------------------------------ uploads

  /**
   * Reserve `length` bytes of the set's quota for a new upload. Reservations
   * make the per-set cap hold across concurrent uploads, not just sequential ones.
   */
  async beginUpload(set, name, length, { chunked = false } = {}) {
    const { maxSetBytes, maxFilesPerSet } = this.config;
    if (set.files.size + set.uploads.size >= maxFilesPerSet) {
      throw new HttpError(409, 'TOO_MANY_FILES', `A file set can hold at most ${maxFilesPerSet} files.`);
    }
    const remaining = maxSetBytes - set.usedBytes - set.reservedBytes;
    if (length > remaining) {
      throw new HttpError(413, 'SET_QUOTA_EXCEEDED',
        `"${name}" (${formatBytes(length)}) does not fit: this file set has ${formatBytes(Math.max(0, remaining))} `
        + `left of its ${formatBytes(maxSetBytes)} limit`
        + `${set.reservedBytes > 0 ? ' (counting uploads still in progress)' : ''}.`);
    }

    const id = newFileId();
    const upload = {
      id, set, name, length, chunked,
      received: 0,
      busy: !chunked,          // a request is currently writing to this upload
      lastActivity: Date.now(),
      released: false,
      cancel: null,            // aborts the request currently writing, if any
      tmpPath: path.join(this.tmpDir(set.id), id),
    };
    set.reservedBytes += length;
    set.uploads.set(id, upload);

    try {
      await this.checkDiskSpace();
      await fsp.writeFile(upload.tmpPath, '', { flag: 'wx' });
    } catch (err) {
      this.releaseUpload(upload);
      throw err;
    }
    return upload;
  }

  async checkDiskSpace() {
    const st = await fsp.statfs(this.config.dataDir);
    const free = st.bavail * st.bsize;
    let outstanding = 0;
    for (const set of this.sets.values()) {
      for (const u of set.uploads.values()) outstanding += u.length - u.received;
    }
    if (free - this.config.diskReserveBytes < outstanding) {
      this.log.warn('rejecting upload: storage volume nearly full', { freeBytes: free, outstandingBytes: outstanding });
      throw new HttpError(507, 'INSUFFICIENT_STORAGE',
        'The server is running low on disk space and cannot accept this upload right now. Please try again later.');
    }
  }

  releaseUpload(upload) {
    if (upload.released) return;
    upload.released = true;
    upload.set.reservedBytes -= upload.length;
    upload.set.uploads.delete(upload.id);
  }

  async abortUpload(upload) {
    this.releaseUpload(upload);
    await fsp.rm(upload.tmpPath, { force: true }).catch((err) =>
      this.log.error('failed to remove partial upload', { set: setRef(upload.set.id), err }));
  }

  async commitUpload(upload) {
    const { set } = upload;
    if (set.deleted || set.expiresAt <= Date.now()) {
      throw new HttpError(410, 'SET_EXPIRED', 'The file set expired or was deleted before the upload finished.');
    }
    if (upload.received !== upload.length) {
      throw new Error(`commitUpload called with ${upload.received} of ${upload.length} bytes`);
    }
    const finalPath = path.join(this.filesDir(set.id), upload.id);
    await fsp.rename(upload.tmpPath, finalPath);
    const file = { id: upload.id, name: upload.name, size: upload.received, uploadedAt: Date.now() };
    this.releaseUpload(upload);
    set.files.set(file.id, file);
    set.usedBytes += file.size;
    try {
      await this.persist(set);
    } catch (err) {
      set.files.delete(file.id);
      set.usedBytes -= file.size;
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      throw err;
    }
    this.log.info('file uploaded', {
      set: setRef(set.id), fileId: file.id, bytes: file.size, setUsedBytes: set.usedBytes,
    });
    return file;
  }

  async deleteFile(set, fileId) {
    const file = isValidFileId(fileId) ? set.files.get(fileId) : undefined;
    if (!file) throw new HttpError(404, 'FILE_NOT_FOUND', 'File not found.');
    set.files.delete(file.id);
    set.usedBytes -= file.size;
    await fsp.rm(this.filePath(set, file), { force: true });
    await this.persist(set);
    this.log.info('file deleted', { set: setRef(set.id), fileId: file.id, bytes: file.size });
  }

  getUpload(set, uploadId) {
    return isValidFileId(uploadId) ? set.uploads.get(uploadId) ?? null : null;
  }

  async cancelUpload(set, uploadId) {
    const upload = this.getUpload(set, uploadId);
    if (!upload) throw new HttpError(404, 'UPLOAD_NOT_FOUND', 'Upload not found. It may have finished, been cancelled, or timed out.');
    upload.cancel?.();
    await this.abortUpload(upload);
    this.log.info('upload cancelled', { set: setRef(set.id), fileId: upload.id, received: upload.received });
  }

  getFile(set, fileId) {
    return isValidFileId(fileId) ? set.files.get(fileId) ?? null : null;
  }
}

module.exports = { SetStore, isValidSetId, isValidFileId };
