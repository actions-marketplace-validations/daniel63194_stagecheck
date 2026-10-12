import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBinary, readTarball } from '../src/tar.js';
import { makeTarball } from './helpers.js';

describe('readTarball', () => {
  it('reads files and strips the top-level folder', () => {
    const tgz = makeTarball({ 'package.json': '{}', 'lib/a.js': 'a', 'bin/run': { data: '#!/bin/sh', mode: 0o755 } });
    const files = readTarball(tgz);
    expect([...files.keys()].sort()).toEqual(['bin/run', 'lib/a.js', 'package.json']);
    expect(files.get('lib/a.js')?.data.toString()).toBe('a');
    expect(files.get('bin/run')?.mode).toBe(0o755);
  });

  it('accepts any top-level folder name, like npm does', () => {
    expect([...readTarball(makeTarball({ 'index.js': 'x' }, { root: 'node-demo' })).keys()]).toEqual(['index.js']);
  });

  it('handles pax and GNU long names', () => {
    const long = `${'deep/'.repeat(25)}file.js`;
    expect(readTarball(makeTarball({ [long]: 'pax' })).get(long)?.data.toString()).toBe('pax');
    expect(readTarball(makeTarball({ [long]: 'gnu' }, { gnu: true })).get(long)?.data.toString()).toBe('gnu');
  });

  it('reads uncompressed tar', () => {
    expect(readTarball(makeTarball({ 'a.txt': 'x' }, { gzip: false })).get('a.txt')?.data.toString()).toBe('x');
  });

  it('skips directories, links and path traversal', () => {
    const tgz = makeTarball({ 'dir/': { data: '', type: '5' }, 'link': { data: '', type: '2' }, '../evil.js': 'x', 'ok.js': 'y' });
    expect([...readTarball(tgz).keys()]).toEqual(['ok.js']);
  });

  it('rejects truncated archives and decompression bombs', () => {
    const tar = makeTarball({ 'a.txt': 'x'.repeat(2000) }, { gzip: false });
    expect(() => readTarball(tar.subarray(0, 1024))).toThrow(/Truncated/);
    expect(() => readTarball(makeTarball({ 'big.txt': 'x'.repeat(100_000) }), { maxBytes: 10_000 })).toThrow();
  });

  it('rejects a negative entry size instead of looping forever', () => {
    const tar = makeTarball({ 'a.txt': 'x' }, { gzip: false });
    tar.fill(0, 512 + 124, 512 + 136);
    tar.write('-1000', 512 + 124, 'latin1');
    expect(() => readTarball(tar)).toThrow(/bad entry size/);
  });

  it('reads a tarball produced by npm pack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stagecheck-test-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'packed-demo', version: '1.2.3', main: 'index.js' }));
      writeFileSync(join(dir, 'index.js'), 'module.exports = 1;\n');
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--silent'], { cwd: dir, shell: process.platform === 'win32' });
      const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz')) as string;
      const files = readTarball(readFileSync(join(dir, tgz)));
      expect(files.has('index.js')).toBe(true);
      expect(JSON.parse(files.get('package.json')?.data.toString() ?? '{}').version).toBe('1.2.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isBinary', () => {
  it('detects NUL bytes', () => {
    expect(isBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))).toBe(true);
    expect(isBinary(Buffer.from('plain text'))).toBe(false);
  });
});
