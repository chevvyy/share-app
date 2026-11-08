'use strict';

/**
 * Minimal ZIP writer for archive downloads. Entries are *stored* (method 0, no
 * compression), so the exact archive length is known before a byte is sent and
 * no CPU goes into deflating. ZIP64 records are added whenever a size, offset or
 * entry count no longer fits the classic 32/16-bit fields (a 5 GiB set needs it).
 *
 * planZip() only builds headers: it returns the archive as a list of parts, each
 * either a header buffer or a reference to an entry's contents, plus the total
 * length. The caller streams the parts in order.
 */

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800; // general-purpose bit 11: names are UTF-8
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const MADE_BY_UNIX = 3 << 8;
const UNIX_FILE_MODE = 0o100644;
const EMPTY = Buffer.alloc(0);

/** MS-DOS date/time (local time of the server; the container runs in UTC). */
function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01, the earliest DOS date
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** ZIP64 extended-information extra field (header id 0x0001) holding the given 64-bit values in order. */
function zip64Extra(values) {
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return buf;
}

/**
 * @param {{name: string, size: number, crc32: number, mtime: number}[]} entries  final entry names
 * @returns {{parts: ({buffer: Buffer}|{index: number, size: number})[], length: number, zip64: boolean}}
 */
function planZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  let anyZip64 = false;

  entries.forEach((e, index) => {
    const name = Buffer.from(e.name, 'utf8');
    const bigSize = e.size >= MAX32;
    const bigOffset = offset >= MAX32;
    const zip64 = bigSize || bigOffset;
    anyZip64 ||= zip64;
    const version = zip64 ? VERSION_ZIP64 : VERSION_DEFAULT;
    const { time, date } = dosDateTime(e.mtime);

    // Local header: sizes go in a ZIP64 extra field (both of them) when they overflow.
    const localExtra = bigSize ? zip64Extra([e.size, e.size]) : EMPTY;
    const local = Buffer.alloc(30 + name.length + localExtra.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc32 >>> 0, 14);
    local.writeUInt32LE(bigSize ? MAX32 : e.size, 18);
    local.writeUInt32LE(bigSize ? MAX32 : e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    name.copy(local, 30);
    localExtra.copy(local, 30 + name.length);
    parts.push({ buffer: local }, { index, size: e.size });

    // Central header: only the overflowing fields go in the extra, in APPNOTE order.
    const extraValues = [];
    if (bigSize) extraValues.push(e.size, e.size);
    if (bigOffset) extraValues.push(offset);
    const centralExtra = extraValues.length > 0 ? zip64Extra(extraValues) : EMPTY;
    const cen = Buffer.alloc(46 + name.length + centralExtra.length);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(MADE_BY_UNIX | version, 4);
    cen.writeUInt16LE(version, 6);
    cen.writeUInt16LE(FLAG_UTF8, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(e.crc32 >>> 0, 16);
    cen.writeUInt32LE(bigSize ? MAX32 : e.size, 20);
    cen.writeUInt32LE(bigSize ? MAX32 : e.size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(centralExtra.length, 30);
    cen.writeUInt16LE(0, 32); // comment length
    cen.writeUInt16LE(0, 34); // disk number start
    cen.writeUInt16LE(0, 36); // internal attributes
    cen.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
    cen.writeUInt32LE(bigOffset ? MAX32 : offset, 42);
    name.copy(cen, 46);
    centralExtra.copy(cen, 46 + name.length);
    central.push(cen);

    offset += local.length + e.size;
  });

  const cdOffset = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  parts.push(...central.map((buffer) => ({ buffer })));
  offset += cdSize;

  const count = entries.length;
  const zip64 = anyZip64 || count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(SIG_ZIP64_END, 0);
    rec.writeBigUInt64LE(44n, 4); // size of the rest of this record
    rec.writeUInt16LE(MADE_BY_UNIX | VERSION_ZIP64, 12);
    rec.writeUInt16LE(VERSION_ZIP64, 14);
    rec.writeUInt32LE(0, 16); // this disk
    rec.writeUInt32LE(0, 20); // disk with the central directory
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset), 8); // where the ZIP64 end record starts
    locator.writeUInt32LE(1, 16); // total number of disks
    parts.push({ buffer: rec }, { buffer: locator });
    offset += rec.length + locator.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  parts.push({ buffer: end });
  offset += end.length;

  return { parts, length: offset, zip64 };
}

/** Make one path segment safe to extract on Windows (entry names only; stored names are untouched). */
function windowsSafeSegment(seg) {
  return seg.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
}

/**
 * Entry names for `files` (sorted, each with a validated `path` and `name`),
 * relative to the folder `prefix`. Names that collide (case-insensitively, as on
 * Windows and macOS) get " (2)", " (3)", ... before the extension. Folder names
 * are reserved first, so a file named like a folder beside it is the one renamed.
 */
function entryNames(files, prefix) {
  const split = files.map((f) => {
    let rel = f.path || '';
    if (prefix) rel = rel === prefix ? '' : rel.slice(prefix.length + 1);
    return [...(rel ? rel.split('/') : []), f.name].map(windowsSafeSegment);
  });
  const taken = new Set();
  for (const segments of split) {
    for (let i = 1; i < segments.length; i += 1) taken.add(segments.slice(0, i).join('/').toLowerCase());
  }
  return split.map((segments) => {
    const last = segments.pop();
    const dir = segments.length > 0 ? `${segments.join('/')}/` : '';
    const dot = last.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [last.slice(0, dot), last.slice(dot)] : [last, ''];
    let candidate = dir + last;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${dir}${stem} (${n})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

module.exports = { planZip, entryNames, windowsSafeSegment, dosDateTime, MAX32, MAX16 };
