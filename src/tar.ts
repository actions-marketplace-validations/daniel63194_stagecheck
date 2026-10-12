import { gunzipSync } from 'node:zlib';

/** One file from a package tarball. */
export interface TarFile {
  /** Path inside the package, without the top-level folder (`package/`). */
  readonly path: string;
  readonly data: Buffer;
  /** Unix permission bits. */
  readonly mode: number;
}

export interface ReadTarballOptions {
  /** Refuse archives that expand beyond this many bytes. Default 512 MiB. */
  maxBytes?: number;
}

const BLOCK = 512;

function cString(buf: Buffer, start: number, length: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

function octal(buf: Buffer, start: number, length: number): number {
  // GNU base-256 encoding for large values: high bit of the first byte is set.
  if ((buf[start] ?? 0) & 0x80) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + (buf[i] ?? 0);
    return value;
  }
  const text = cString(buf, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number.parseInt(data.toString('utf8', i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.toString('utf8', space + 1, i + len - 1); // drop trailing newline
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Normalises an archive path and strips the first component, as npm does. */
function packagePath(raw: string): string | null {
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length < 2) return null; // the top-level folder itself, or a stray root file
  if (parts.some((p) => p === '..')) return null;
  return parts.slice(1).join('/');
}

/**
 * Reads an npm package tarball (`.tgz`, or an uncompressed `.tar`) into memory.
 * Supports ustar, pax extended headers and GNU long names. Directories, links
 * and other special entries are skipped; only regular files are returned.
 */
export function readTarball(archive: Uint8Array, options: ReadTarballOptions = {}): Map<string, TarFile> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const input = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const tar = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: maxBytes }) : input;

  const files = new Map<string, TarFile>();
  let offset = 0;
  let longName: string | undefined;
  let pax: Record<string, string> = {};

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end of archive

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Truncated tar archive');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'g') continue; // global pax header: nothing we need
    if (type === 'L') {
      longName = cString(data, 0, data.length);
      continue;
    }

    let name = cString(header, 0, 100);
    const magic = header.toString('latin1', 257, 262);
    if (magic === 'ustar') {
      const prefix = cString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== undefined) name = longName;
    if (pax.path !== undefined) name = pax.path;
    longName = undefined;
    pax = {};

    if (type !== '0' && type !== '\0' && type !== '7') continue; // not a regular file
    const path = packagePath(name);
    if (path === null) continue;
    files.set(path, { path, data: Buffer.from(data), mode: octal(header, 100, 8) & 0o7777 });
  }
  return files;
}

/** True when the bytes look like binary rather than text. */
export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
