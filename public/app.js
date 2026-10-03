'use strict';

(() => {
  const SET_ID_RE = /^[A-Za-z0-9_-]{43}$/;
  const TTL_PRESETS_MIN = [5, 15, 30, 60, 120, 180, 240, 300, 360];
  const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
  const MAX_CHUNK_RETRIES = 6;

  const $ = (id) => document.getElementById(id);
  const el = {
    message: $('message'), home: $('home'), setView: $('set-view'),
    createForm: $('create-form'), ttl: $('ttl'), limitsHint: $('limits-hint'),
    openForm: $('open-form'), openId: $('open-id'),
    setId: $('set-id'), shareLink: $('share-link'), copyId: $('copy-id'), copyLink: $('copy-link'),
    countdown: $('countdown'), expiresAt: $('expires-at'), usageBar: $('usage-bar'), usageText: $('usage-text'),
    uploadForm: $('upload-form'), files: $('files'), uploadBtn: $('upload-btn'), cancelUpload: $('cancel-upload'),
    uploadStatus: $('upload-status'), fileTable: $('file-table'), fileList: $('file-list'), emptyMsg: $('empty-msg'),
    refresh: $('refresh'), deleteSet: $('delete-set'), closeSet: $('close-set'),
  };

  const state = {
    config: null,
    set: null,
    clockOffsetMs: 0, // server clock minus local clock
    timer: null,
    uploading: false,
    currentXhr: null,
    cancelRequested: false,
  };

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

  function renderFiles(set) {
    el.fileList.replaceChildren();
    el.emptyMsg.hidden = set.files.length > 0;
    el.fileTable.hidden = set.files.length === 0;
    for (const file of set.files) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = file.name;

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
      if (state.currentXhr) state.currentXhr.abort();
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
    if (state.uploading && state.currentXhr) {
      state.cancelRequested = true;
      state.currentXhr.abort();
    }
    state.set = null;
    clearInterval(state.timer);
    state.timer = null;
    el.setView.hidden = true;
    el.home.hidden = false;
    el.uploadStatus.replaceChildren();
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

  function addStatusRow(file) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'uname';
    name.textContent = `${file.name} (${formatBytes(file.size)})`;
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
      },
      done(text) { li.className = 'ok'; bar.value = bar.max; status.textContent = text; },
      fail(text) { li.className = 'err'; status.textContent = text; },
      setText(text) { status.textContent = text; },
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** XHR (not fetch) so uploads report progress. Resolves with the parsed JSON body on 2xx. */
  function xhrRequest(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.currentXhr = xhr;
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
  async function uploadOne(setId, file, row) {
    const startedAt = performance.now();
    const chunkBytes = state.config?.chunkBytes || DEFAULT_CHUNK_BYTES;
    if (file.size <= chunkBytes) {
      return xhrRequest('POST', `${setUrl(setId)}/files?name=${encodeURIComponent(file.name)}`, file,
        (loaded) => row.progress(loaded, startedAt));
    }

    const session = await xhrRequest('POST', `${setUrl(setId)}/uploads`, JSON.stringify({ name: file.name, size: file.size }));
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

  async function onUpload(ev) {
    ev.preventDefault();
    clearMessage();
    if (!state.set || state.uploading) return;
    const files = [...el.files.files];
    if (files.length === 0) return;

    state.uploading = true;
    state.cancelRequested = false;
    el.uploadBtn.disabled = true;
    el.files.disabled = true;
    el.cancelUpload.hidden = false;
    el.uploadStatus.replaceChildren();
    const rows = files.map(addStatusRow);
    const setId = state.set.id;
    let failures = 0;

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const row = rows[i];
      if (state.cancelRequested || !state.set) { row.fail('Cancelled.'); continue; }
      // Client-side pre-check for a friendly message; the server enforces the real limit.
      const free = state.set.maxBytes - state.set.usedBytes - state.set.reservedBytes;
      if (file.size > free) {
        row.fail(`Does not fit: ${formatBytes(Math.max(0, free))} left in this file set.`);
        failures += 1;
        continue;
      }
      row.setText('Uploading…');
      try {
        const result = await uploadOne(setId, file, row);
        row.done('Uploaded.');
        if (state.set && result?.set) showSet(result.set);
      } catch (err) {
        row.fail(err.message);
        failures += 1;
        if (err.code === 'SET_NOT_FOUND' || err.code === 'SET_EXPIRED') break;
        if (err.code === 'ABORTED') state.cancelRequested = true;
      }
    }

    state.uploading = false;
    state.currentXhr = null;
    el.uploadBtn.disabled = false;
    el.files.disabled = false;
    el.cancelUpload.hidden = true;
    el.files.value = '';
    if (failures > 0 && !state.cancelRequested) showMessage(`${failures} of ${files.length} upload(s) failed. See details below.`);
    await refreshSet();
  }

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
  el.cancelUpload.addEventListener('click', () => {
    state.cancelRequested = true;
    state.currentXhr?.abort();
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
