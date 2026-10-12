import { gzipSync } from 'node:zlib';
import { readTarball, type TarFile } from '../src/tar.js';

type Entry = string | Buffer | { data: string | Buffer; mode?: number; type?: string };

function header(name: string, size: number, mode: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/**
 * Builds an npm-style tarball. Paths longer than 100 bytes are written with a
 * pax header (or a GNU long-name entry when `gnu` is set).
 */
export function makeTarball(files: Record<string, Entry>, options: { root?: string; gnu?: boolean; gzip?: boolean } = {}): Buffer {
  const root = options.root ?? 'package';
  const parts: Buffer[] = [header(`${root}/`, 0, 0o755, '5')];
  for (const [path, entry] of Object.entries(files)) {
    const e = typeof entry === 'string' || Buffer.isBuffer(entry) ? { data: entry } : entry;
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const full = `${root}/${path}`;
    if (Buffer.byteLength(full) > 100) {
      if (options.gnu) {
        const name = Buffer.from(`${full}\0`, 'utf8');
        parts.push(header('././@LongLink', name.length, 0o644, 'L'), pad(name));
      } else {
        // The length prefix counts bytes, including itself.
        const body = ` path=${full}\n`;
        let len = Buffer.byteLength(body);
        while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
        const record = Buffer.from(`${len}${body}`, 'utf8');
        parts.push(header('PaxHeader', record.length, 0o644, 'x'), pad(record));
      }
    }
    parts.push(header(full, data.length, e.mode ?? 0o644, e.type ?? '0'), pad(data));
  }
  parts.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(parts);
  return options.gzip === false ? tar : gzipSync(tar);
}

/** A file map, as returned by `readTarball`, for building reviews directly. */
export function files(entries: Record<string, Entry>): Map<string, TarFile> {
  return readTarball(makeTarball(entries));
}

export function pkg(json: Record<string, unknown>): string {
  return JSON.stringify({ name: 'demo', version: '1.0.0', ...json }, null, 2);
}

/** A small, clean package used as the "previous version" in many tests. */
export function cleanPackage(version = '1.0.0', extra: Record<string, Entry> = {}, manifest: Record<string, unknown> = {}): Record<string, Entry> {
  return {
    'package.json': pkg({ version, main: 'index.js', dependencies: { kleur: '^4.1.5' }, ...manifest }),
    'index.js': "'use strict';\nconst kleur = require('kleur');\nmodule.exports = function greet(name) {\n  return kleur.green(`Hello, ${name}!`);\n};\n",
    'README.md': '# demo\n\nGreets people.\n',
    ...extra,
  };
}
