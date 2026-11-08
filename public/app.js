'use strict';

(() => {
  const SET_ID_RE = /^[A-Za-z0-9_-]{43}$/;
  const TTL_PRESETS_MIN = [5, 15, 30, 60, 120, 180, 240, 300, 360];
  const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
  const MAX_CHUNK_RETRIES = 6;
  const PARALLEL_SMALL_UPLOADS = 3;
  const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

  const $ = (id) => document.getElementById(id);
  const el = {
    message: $('message'), home: $('home'), setView: $('set-view'),
    createForm: $('create-form'), ttl: $('ttl'), limitsHint: $('limits-hint'),
    openForm: $('open-form'), openId: $('open-id'),
    setId: $('set-id'), shareLink: $('share-link'), copyId: $('copy-id'), copyLink: $('copy-link'),
    countdown: $('countdown'), expiresAt: $('expires-at'), usageBar: $('usage-bar'), usageText: $('usage-text'),
    uploadForm: $('upload-form'), files: $('files'), uploadBtn: $('upload-btn'), cancelUpload: $('cancel-upload'),
    uploadCard: $('upload-card'), chooseFolder: $('choose-folder'), folder: $('folder'),
    overall: $('overall'), overallBar: $('overall-bar'), overallText: $('overall-text'),
    uploadStatus: $('upload-status'), fileTable: $('file-table'), fileList: $('file-list'), emptyMsg: $('empty-msg'),
    downloadAll: $('download-all'), refresh: $('refresh'), deleteSet: $('delete-set'), closeSet: $('close-set'),
  };

  const state = {
    config: null,
    set: null,
    clockOffsetMs: 0, // server clock minus local clock
    timer: null,
    uploading: false,
    xhrs: new Set(), // upload requests in flight (up to PARALLEL_SMALL_UPLOADS + 1)
    cancelRequested: false,
  };

  const abortAll = () => { for (const xhr of state.xhrs) xhr.abort(); };

  // ---------------------------------------------------------------- helpers

  function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = Math.max(0, bytes);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function ttlLabel(minutes) {
    if (minutes < 60) return `${minutes} minutes`;
    const h = minutes / 60;
    return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'}` : `${h.toFixed(1)} hours`;
  }

  function showMessage(text, kind = 'error') {
    el.message.textContent = text;
    el.message.className = `message ${kind}`;
    el.message.hidden = false;
    if (kind === 'info') setTimeout(() => { if (el.message.textContent === text) el.message.hidden = true; }, 4000);
  }

  function clearMessage() { el.message.hidden = true; }

  class ApiError extends Error {
    constructor(message, status, code, details = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function api(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new ApiError('Network error: could not reach the server.', 0, 'NETWORK');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body, e.g. a proxy error page */ }
    if (!res.ok) {
      throw new ApiError(data?.error?.message || `Request failed (HTTP ${res.status}).`, res.status, data?.error?.code);
    }
    return data;
  }

  const setUrl = (id) => `/api/sets/${encodeURIComponent(id)}`;

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      showMessage(`${what} copied to clipboard.`, 'info');
    } catch {
      showMessage(`Could not copy automatically. Select the ${what.toLowerCase()} and copy it manually.`);
    }
  }

  // ---------------------------------------------------------------- home

  async function loadConfig() {
    try {
      state.config = await api('GET', '/api/config');
    } catch (err) {
      showMessage(`Could not load server settings: ${err.message}`);
      return;
    }
    const { minTtlSeconds, maxTtlSeconds, maxSetBytes, maxSets, activeSets } = state.config;
    el.ttl.replaceChildren();
    const presets = TTL_PRESETS_MIN.filter((m) => m * 60 >= minTtlSeconds && m * 60 <= maxTtlSeconds);
    if (!presets.includes(maxTtlSeconds / 60) && Number.isInteger(maxTtlSeconds / 60)) presets.push(maxTtlSeconds / 60);
    for (const minutes of presets) {
      const opt = document.createElement('option');
      opt.value = String(minutes * 60);
      opt.textContent = ttlLabel(minutes);
      if (minutes === 60) opt.selected = true;
      el.ttl.append(opt);
    }
    el.limitsHint.textContent = `Up to ${formatBytes(maxSetBytes)} per file set, deleted after at most `
      + `${ttlLabel(maxTtlSeconds / 60)}. ${activeSets} of ${maxSets} file sets currently in use.`;
  }

  async function onCreate(ev) {
    ev.preventDefault();
    clearMessage();
    const button = el.createForm.querySelector('button');
    button.disabled = true;
    try {
      const set = await api('POST', '/api/sets', { ttlSeconds: Number(el.ttl.value) });
      location.hash = set.id; // triggers openSet via hashchange
    } catch (err) {
      showMessage(err.message);
      loadConfig();
    } finally {
      button.disabled = false;
    }
  }

  function onOpen(ev) {
    ev.preventDefault();
    clearMessage();
    let id = el.openId.value.trim();
    // Accept a pasted share link as well as a bare ID.
    const hashAt = id.lastIndexOf('#');
    if (hashAt !== -1) id = id.slice(hashAt + 1);
    if (!SET_ID_RE.test(id)) {
      showMessage('That does not look like a valid file set ID (43 letters, digits, "-" or "_").');
      return;
    }
    if (location.hash.slice(1) === id) openSet(id); else location.hash = id;
  }

  // ---------------------------------------------------------------- set view

  async function openSet(id) {
    clearMessage();
    try {
      const set = await api('GET', setUrl(id));
      showSet(set);
    } catch (err) {
      closeSet(false);
      showMessage(err.message);
    }
  }

  function showSet(set) {
    state.set = set;
    state.clockOffsetMs = Date.parse(set.serverTime) - Date.now();
    el.home.hidden = true;
    el.setView.hidden = false;
    el.setId.textContent = set.id;
    el.shareLink.textContent = `${location.origin}/#${set.id}`;
    el.expiresAt.textContent = `(at ${new Date(set.expiresAt).toLocaleString()})`;
    const used = set.usedBytes + set.reservedBytes;
    el.usageBar.max = set.maxBytes;
    el.usageBar.value = Math.min(used, set.maxBytes);
    el.usageText.textContent = `${formatBytes(set.usedBytes)} of ${formatBytes(set.maxBytes)} used`
      + (set.reservedBytes > 0 ? ` (+${formatBytes(set.reservedBytes)} uploading)` : '');
    renderFiles(set);
    tick();
    if (!state.timer) state.timer = setInterval(tick, 1000);
  }

  /** Folder by folder (segment-wise, so subfolders follow their parent), then by name. */
  function comparePathName(a, b) {
    const pa = a.path ? a.path.split('/') : [];
    const pb = b.path ? b.path.split('/') : [];
    for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
      if (pa[i] !== pb[i]) return pa[i].localeCompare(pb[i], undefined, { numeric: true }) || (pa[i] < pb[i] ? -1 : 1);
    }
    if (pa.length !== pb.length) return pa.length - pb.length;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  }

  const indent = (cell, depth) => { if (depth > 0) cell.style.paddingLeft = `${0.4 + depth * 1.25}rem`; };
  const archiveUrl = (setId, folder) => `${setUrl(setId)}/archive${folder ? `?path=${encodeURIComponent(folder)}` : ''}`;

  function folderRow(set, segments) {
    const tr = document.createElement('tr');
    tr.className = 'folder';
    const name = document.createElement('td');
    name.className = 'name';
    name.colSpan = 3;
    name.textContent = `${segments.at(-1)}/`;
    indent(name, segments.length - 1);
    const actions = document.createElement('td');
    actions.className = 'actions';
    const link = document.createElement('a');
    link.href = archiveUrl(set.id, segments.join('/'));
    link.textContent = 'Download folder (.zip)';
    actions.append(link);
    tr.append(name, actions);
    return tr;
  }

  function renderFiles(set) {
    el.fileList.replaceChildren();
    el.emptyMsg.hidden = set.files.length > 0;
    el.fileTable.hidden = set.files.length === 0;
    el.downloadAll.hidden = set.files.length < 2;
    el.downloadAll.href = archiveUrl(set.id, '');
    let prev = [];
    for (const file of [...set.files].sort(comparePathName)) {
      const segments = file.path ? file.path.split('/') : [];
      let common = 0;
      while (common < prev.length && common < segments.length && prev[common] === segments[common]) common += 1;
      for (let depth = common; depth < segments.length; depth += 1) {
        el.fileList.append(folderRow(set, segments.slice(0, depth + 1)));
      }
      prev = segments;

      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = file.name;
      indent(name, segments.length);

      const size = document.createElement('td');
      size.className = 'num';
      size.textContent = formatBytes(file.size);

      const when = document.createElement('td');
      when.className = 'muted';
      when.textContent = new Date(file.uploadedAt).toLocaleTimeString();

      const actions = document.createElement('td');
      actions.className = 'actions';
      const link = document.createElement('a');
      link.href = `${setUrl(set.id)}/files/${encodeURIComponent(file.id)}`;
      link.textContent = 'Download';
      link.setAttribute('download', file.name);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary small';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteFile(file));
      actions.append(link, del);

      tr.append(name, size, when, actions);
      el.fileList.append(tr);
    }
  }

  function tick() {
    if (!state.set) return;
    const remaining = (Date.parse(state.set.expiresAt) - (Date.now() + state.clockOffsetMs)) / 1000;
    if (remaining <= 0) {
      el.countdown.textContent = 'Expired';
      el.countdown.classList.add('soon');
      const id = state.set.id;
      closeSet(false);
      abortAll();
      showMessage('This file set has expired and its files have been deleted.');
      if (location.hash.slice(1) === id) history.replaceState(null, '', location.pathname);
      return;
    }
    el.countdown.textContent = formatClock(remaining);
    el.countdown.classList.toggle('soon', remaining < 300);
  }

  async function refreshSet() {
    if (!state.set) return;
    try {
      showSet(await api('GET', setUrl(state.set.id)));
    } catch (err) {
      if (err.status === 404) {
        closeSet(false);
        history.replaceState(null, '', location.pathname);
      }
      showMessage(err.message);
    }
  }

  function closeSet(updateHash = true) {
    if (state.uploading) {
      state.cancelRequested = true;
      abortAll();
    }
    state.set = null;
    clearInterval(state.timer);
    state.timer = null;
    el.setView.hidden = true;
    el.home.hidden = false;
    el.uploadStatus.replaceChildren();
    el.overall.hidden = true;
    if (updateHash && location.hash) history.pushState(null, '', location.pathname);
    loadConfig();
  }

  async function deleteFile(file) {
    if (!confirm(`Delete "${file.name}"?`)) return;
    try {
      await api('DELETE', `${setUrl(state.set.id)}/files/${encodeURIComponent(file.id)}`);
      showMessage(`Deleted "${file.name}".`, 'info');
    } catch (err) {
      showMessage(err.message);
    }
    refreshSet();
  }

  async function deleteSet() {
    if (!state.set) return;
    if (!confirm('Delete this file set and all of its files now? This cannot be undone.')) return;
    try {
      await api('DELETE', setUrl(state.set.id));
      closeSet();
      showMessage('File set deleted.', 'info');
    } catch (err) {
      showMessage(err.message);
    }
  }

  // ---------------------------------------------------------------- uploads

  /** A per-file row, shown only while the file is uploading or after it failed. */
  function addStatusRow(file, folder, onProgress) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'uname';
    name.textContent = `${folder ? `${folder}/` : ''}${file.name} (${formatBytes(file.size)})`;
    const bar = document.createElement('progress');
    bar.max = Math.max(file.size, 1);
    bar.value = 0;
    const status = document.createElement('span');
    status.className = 'ustate';
    status.textContent = 'Waiting…';
    li.append(name, bar, status);
    el.uploadStatus.append(li);
    return {
      progress(loaded, startedAt) {
        bar.value = loaded;
        const secs = (performance.now() - startedAt) / 1000;
        const rate = secs > 0 ? loaded / secs : 0;
        status.textContent = `${Math.floor((loaded / Math.max(file.size, 1)) * 100)}% · ${formatBytes(rate)}/s`;
        onProgress?.(loaded);
      },
      done(text) { li.className = 'ok'; bar.value = bar.max; status.textContent = text; },
      fail(text) { li.className = 'err'; status.textContent = text; },
      remove() { li.remove(); },
      setText(text) { status.textContent = text; },
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** XHR (not fetch) so uploads report progress. Resolves with the parsed JSON body on 2xx. */
  function xhrRequest(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.xhrs.add(xhr);
      xhr.onloadend = () => state.xhrs.delete(xhr);
      xhr.open(method, url);
      xhr.responseType = 'text';
      if (typeof body === 'string') xhr.setRequestHeader('Content-Type', 'application/json');
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* e.g. an HTML error page from a proxy */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          reject(new ApiError(data?.error?.message || `Upload failed (HTTP ${xhr.status}).`,
            xhr.status, data?.error?.code, data?.error));
        }
      };
      xhr.onerror = () => reject(new ApiError(
        'The connection was interrupted. The file set may have expired, hit its limit, or the network dropped.', 0, 'NETWORK'));
      xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0, 'ABORTED'));
      xhr.send(body);
    });
  }

  function isRetryable(err) {
    if (err.code === 'ABORTED') return false;
    if (err.code === 'NETWORK' || err.code === 'UPLOAD_BUSY' || err.code === 'UPLOAD_ABORTED') return true;
    return err.status === 429 || (err.status >= 500 && err.status !== 507);
  }

  /**
   * Upload one file. Small files go in a single request. Larger files are sent
   * as sequential chunks, so no single request exceeds proxy body limits (e.g.
   * Cloudflare's 100 MB), and a dropped connection only retries one chunk.
   */
  async function uploadOne(setId, file, row, folder = '') {
    const startedAt = performance.now();
    const chunkBytes = state.config?.chunkBytes || DEFAULT_CHUNK_BYTES;
    if (file.size <= chunkBytes) {
      const pathParam = folder ? `&path=${encodeURIComponent(folder)}` : '';
      return xhrRequest('POST', `${setUrl(setId)}/files?name=${encodeURIComponent(file.name)}${pathParam}`, file,
        (loaded) => row.progress(loaded, startedAt));
    }

    const session = await xhrRequest('POST', `${setUrl(setId)}/uploads`,
      JSON.stringify({ name: file.name, size: file.size, ...(folder ? { path: folder } : {}) }));
    const base = `${setUrl(setId)}/uploads/${encodeURIComponent(session.uploadId)}`;
    let offset = 0;
    let failures = 0;
    try {
      while (offset < file.size) {
        if (state.cancelRequested) throw new ApiError('Upload cancelled.', 0, 'ABORTED');
        const end = Math.min(offset + chunkBytes, file.size);
        const chunkStart = offset;
        try {
          const res = await xhrRequest('PUT', `${base}?offset=${chunkStart}`, file.slice(chunkStart, end),
            (loaded) => row.progress(chunkStart + loaded, startedAt));
          failures = 0;
          if (res.file) return res;
          offset = res.received;
        } catch (err) {
          if (err.code === 'OFFSET_MISMATCH' && Number.isSafeInteger(err.details?.expectedOffset)) {
            offset = err.details.expectedOffset; // the server already has more (or less) than we thought
            continue;
          }
          if (err.code === 'UPLOAD_NOT_FOUND' && failures > 0) {
            // The final chunk may have committed even though its response was lost.
            const set = await api('GET', setUrl(setId));
            if (set.files.some((f) => f.id === session.uploadId)) return { set };
          }
          failures += 1;
          if (!isRetryable(err) || failures > MAX_CHUNK_RETRIES) throw err;
          row.setText(`Connection problem; retrying (${failures}/${MAX_CHUNK_RETRIES})…`);
          await sleep(Math.min(30000, 1000 * 2 ** failures));
        }
      }
      throw new ApiError('Upload ended unexpectedly.', 0, 'INCOMPLETE');
    } catch (err) {
      if (!['SET_NOT_FOUND', 'SET_EXPIRED', 'UPLOAD_NOT_FOUND'].includes(err.code)) {
        fetch(base, { method: 'DELETE' }).catch(() => {}); // release the reservation right away
      }
      throw err;
    }
  }

  const isJunk = (name) => JUNK_NAMES.has(name.toLowerCase()) || name.startsWith('._');
  const dirOf = (relPath) => relPath.slice(0, Math.max(0, relPath.lastIndexOf('/')));
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  /** Check the whole batch against the set's limits before sending anything. Returns a message, or null. */
  function precheck(items) {
    const set = state.set;
    const maxDepth = state.config?.maxPathDepth || 32;
    const maxChars = state.config?.maxPathChars || 1024;
    if (set.files.length + items.length > set.maxFiles) {
      return `That is ${plural(items.length, 'file')}, and this file set already holds ${set.files.length.toLocaleString()} `
        + `of at most ${set.maxFiles.toLocaleString()}. Nothing was uploaded.`;
    }
    const total = items.reduce((n, i) => n + i.file.size, 0);
    const free = Math.max(0, set.maxBytes - set.usedBytes - set.reservedBytes);
    if (total > free) {
      return `Those files total ${formatBytes(total)}, but only ${formatBytes(free)} is left in this file set. Nothing was uploaded.`;
    }
    const deep = items.find((i) => i.path && (i.path.split('/').length > maxDepth || [...i.path].length > maxChars));
    if (deep) {
      return `The folder "${deep.path.slice(0, 80)}${deep.path.length > 80 ? '…' : ''}" is nested too deeply or its path is `
        + `too long (at most ${maxDepth} levels and ${maxChars.toLocaleString()} characters). Nothing was uploaded.`;
    }
    return null;
  }

  function setUploadControls(busy) {
    state.uploading = busy;
    el.uploadBtn.disabled = busy;
    el.files.disabled = busy;
    el.chooseFolder.disabled = busy;
    el.cancelUpload.hidden = !busy;
  }

  /**
   * Upload a batch of { file, path } items. Small files go up to three at a
   * time; files big enough to need chunking go one at a time alongside them.
   * Finished files fold into the overall count, so 1000 files stay fast.
   */
  async function startUpload(rawItems) {
    clearMessage();
    if (!state.set) return;
    if (state.uploading) {
      showMessage('An upload is already running. Wait for it to finish, or cancel it first.');
      return;
    }
    const items = rawItems.filter((i) => !isJunk(i.file.name));
    const skipped = rawItems.length - items.length;
    const skippedNote = skipped > 0 ? ` Skipped ${plural(skipped, 'system file')}.` : '';
    if (items.length === 0) {
      showMessage(`Nothing to upload. Empty folders are not kept.${skippedNote}`);
      return;
    }
    // Claim the uploader before the await, so a second drop can't start a parallel batch.
    setUploadControls(true);
    state.cancelRequested = false;
    const setId = state.set.id;
    await refreshSet(); // check against current usage, not what this page last saw
    const stillHere = state.set?.id === setId && !state.cancelRequested;
    const problem = stillHere ? precheck(items) : '';
    if (problem !== null) {
      setUploadControls(false);
      if (problem) showMessage(problem);
      return;
    }

    el.uploadStatus.replaceChildren();
    const chunkBytes = state.config?.chunkBytes || DEFAULT_CHUNK_BYTES;
    const small = items.filter((i) => i.file.size <= chunkBytes);
    const large = items.filter((i) => i.file.size > chunkBytes);
    const totalBytes = items.reduce((n, i) => n + i.file.size, 0);
    const progress = { files: 0, bytes: 0, inflight: new Map(), queued: false };
    let failures = 0;
    let stopped = false;
    let pendingSet = null;
    let setTimer = null;

    const renderOverall = () => {
      progress.queued = false;
      let bytes = progress.bytes;
      for (const loaded of progress.inflight.values()) bytes += loaded;
      el.overallBar.max = Math.max(totalBytes, 1);
      el.overallBar.value = Math.min(bytes, totalBytes);
      el.overallText.textContent = `${progress.files.toLocaleString()} of ${plural(items.length, 'file')}, `
        + `${formatBytes(bytes)} of ${formatBytes(totalBytes)}${failures ? ` · ${failures.toLocaleString()} failed` : ''}`
        + skippedNote;
    };
    const queueOverall = () => {
      if (!progress.queued) { progress.queued = true; requestAnimationFrame(renderOverall); }
    };
    // Re-render the file list at most once a second while files keep landing.
    const queueSetView = (set) => {
      pendingSet = set;
      if (!setTimer) {
        setTimer = setTimeout(() => {
          setTimer = null;
          if (state.set?.id === setId && pendingSet) showSet(pendingSet);
        }, 1000);
      }
    };
    el.overall.hidden = false;
    renderOverall();

    async function lane(queue) {
      while (queue.length > 0 && !state.cancelRequested && !stopped && state.set?.id === setId) {
        const item = queue.shift();
        const key = {};
        const row = addStatusRow(item.file, item.path, (loaded) => {
          progress.inflight.set(key, loaded);
          queueOverall();
        });
        row.setText('Uploading…');
        try {
          const result = await uploadOne(setId, item.file, row, item.path);
          row.remove();
          progress.files += 1;
          progress.bytes += item.file.size;
          if (result?.set) queueSetView(result.set);
        } catch (err) {
          row.fail(err.message);
          failures += 1;
          if (err.code === 'SET_NOT_FOUND' || err.code === 'SET_EXPIRED') stopped = true;
          if (err.code === 'ABORTED') state.cancelRequested = true;
        }
        progress.inflight.delete(key);
        queueOverall();
      }
    }

    const lanes = Array.from({ length: PARALLEL_SMALL_UPLOADS }, () => lane(small));
    await Promise.all([...lanes, lane(large)]);

    clearTimeout(setTimer);
    setUploadControls(false);
    el.files.value = '';
    el.folder.value = '';
    renderOverall();
    const notStarted = small.length + large.length;
    if (notStarted > 0) el.overallText.textContent += ` · ${notStarted.toLocaleString()} not started`;
    if (failures > 0 && !state.cancelRequested) {
      showMessage(`${failures.toLocaleString()} of ${plural(items.length, 'upload')} failed. See details below.`);
    }
    await refreshSet();
  }

  function onUpload(ev) {
    ev.preventDefault();
    const files = [...el.files.files];
    if (files.length > 0) startUpload(files.map((file) => ({ file, path: '' })));
  }

  function onFolderPicked() {
    // webkitRelativePath includes the picked folder's own name: "Trip/raw/a.jpg" -> path "Trip/raw".
    const items = [...el.folder.files].map((file) => ({ file, path: dirOf(file.webkitRelativePath || '') }));
    if (items.length > 0) startUpload(items);
    else showMessage('That folder is empty. Empty folders are not kept.');
  }

  // ---------------------------------------------------------------- drag and drop

  const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

  async function walkEntry(entry, folder, out) {
    if (entry.isFile) {
      out.push({ file: await entryFile(entry), path: folder });
    } else if (entry.isDirectory) {
      const sub = folder ? `${folder}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      // readEntries hands back at most 100 entries per call (Chrome): keep reading until it's empty.
      for (let batch = await readEntries(reader); batch.length > 0; batch = await readEntries(reader)) {
        for (const child of batch) await walkEntry(child, sub, out);
      }
    }
  }

  const draggingFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;

  function onDrop(ev) {
    if (!draggingFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    el.uploadCard.classList.remove('dragover');
    if (!state.set) return;
    // The item list is cleared once this handler returns: take every entry before any await.
    const dt = ev.dataTransfer;
    const fallback = [...dt.files];
    const entries = [];
    if (dt.items && typeof DataTransferItem !== 'undefined' && 'webkitGetAsEntry' in DataTransferItem.prototype) {
      for (const item of dt.items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    if (entries.length === 0) {
      startUpload(fallback.map((file) => ({ file, path: '' })));
      return;
    }
    (async () => {
      const items = [];
      for (const entry of entries) await walkEntry(entry, '', items);
      return items;
    })().then(startUpload, (err) => showMessage(`Could not read the dropped folders: ${err.message || err.name}`));
  }

  el.uploadCard.addEventListener('dragenter', (ev) => {
    if (!draggingFiles(ev)) return;
    ev.preventDefault();
    dragDepth += 1;
    el.uploadCard.classList.add('dragover');
  });
  el.uploadCard.addEventListener('dragover', (ev) => {
    if (!draggingFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = state.uploading ? 'none' : 'copy';
  });
  el.uploadCard.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.uploadCard.classList.remove('dragover');
  });
  el.uploadCard.addEventListener('drop', onDrop);
  // A drop that misses the box must not navigate away from the page (and abort uploads).
  window.addEventListener('dragover', (ev) => { if (draggingFiles(ev)) ev.preventDefault(); });
  window.addEventListener('drop', (ev) => { if (draggingFiles(ev)) ev.preventDefault(); });

  // ---------------------------------------------------------------- wiring

  function routeFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) { if (state.set) closeSet(false); return; }
    if (!SET_ID_RE.test(id)) { showMessage('The link does not contain a valid file set ID.'); return; }
    if (state.set?.id !== id) openSet(id);
  }

  el.createForm.addEventListener('submit', onCreate);
  el.openForm.addEventListener('submit', onOpen);
  el.uploadForm.addEventListener('submit', onUpload);
  el.chooseFolder.addEventListener('click', () => el.folder.click());
  el.folder.addEventListener('change', onFolderPicked);
  el.cancelUpload.addEventListener('click', () => {
    state.cancelRequested = true;
    abortAll();
  });
  el.copyId.addEventListener('click', () => copyText(state.set?.id ?? '', 'ID'));
  el.copyLink.addEventListener('click', () => copyText(el.shareLink.textContent, 'Link'));
  el.refresh.addEventListener('click', refreshSet);
  el.deleteSet.addEventListener('click', deleteSet);
  el.closeSet.addEventListener('click', () => closeSet());
  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('beforeunload', (e) => {
    if (state.uploading) { e.preventDefault(); e.returnValue = ''; }
  });
  // Re-sync with the server when the tab becomes visible again (timers are throttled in background tabs).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.set && !state.uploading) refreshSet(); });

  loadConfig();
  routeFromHash();
})();
