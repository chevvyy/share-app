'use strict';

const { HttpError } = require('./errors');

const MAX_PATH_DEPTH = 32;
const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;
// Control and bidi characters: the same class sanitizeFileName strips from names.
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

function invalidPath(why) {
  return new HttpError(400, 'INVALID_PATH', `Invalid folder path: ${why}.`);
}

/**
 * Validate the folder a file sits in (relative to the picked or dropped root,
 * "/"-separated). The path is display metadata only: files stay stored under
 * random IDs, so it never touches the filesystem. Unlike file names, a bad path
 * is rejected rather than fixed, so the client can show a clear error.
 * Returns the cleaned path, or '' for the top level.
 */
function sanitizeFolderPath(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw invalidPath('it must be a string');
  let p = raw.normalize('NFC').replace(/\\/g, '/');
  if (p.startsWith('/')) throw invalidPath('it must be relative (no leading "/")');
  if (/^[A-Za-z]:/.test(p)) throw invalidPath('it must not start with a drive letter');
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') return '';
  if (BAD_CHARS.test(p)) throw invalidPath('it contains control or bidi characters');
  if ([...p].length > MAX_PATH_CHARS) throw invalidPath(`it is longer than ${MAX_PATH_CHARS} characters`);
  const segments = p.split('/');
  if (segments.length > MAX_PATH_DEPTH) throw invalidPath(`it is nested deeper than ${MAX_PATH_DEPTH} folders`);
  for (const seg of segments) {
    if (seg === '') throw invalidPath('it contains an empty folder name');
    if (seg === '.' || seg === '..') throw invalidPath('"." and ".." are not allowed');
    if ([...seg].length > MAX_SEGMENT_CHARS) throw invalidPath(`a folder name is longer than ${MAX_SEGMENT_CHARS} characters`);
  }
  return p;
}

/** Order files by folder (segment by segment, so subfolders follow their parent), then by name. */
function comparePathName(a, b) {
  const pa = a.path ? a.path.split('/') : [];
  const pb = b.path ? b.path.split('/') : [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.uploadedAt - b.uploadedAt;
}

module.exports = { sanitizeFolderPath, comparePathName, MAX_PATH_DEPTH, MAX_PATH_CHARS, MAX_SEGMENT_CHARS };
