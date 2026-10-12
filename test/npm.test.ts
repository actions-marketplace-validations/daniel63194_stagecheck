import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSpec, compareVersions, previousVersion, resolveNpm } from '../src/npm.js';

describe('resolveNpm', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (path: string, data = ''): string => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
    return path;
  };

  it('runs npm from PATH outside Windows', () => {
    expect(resolveNpm('linux', {})).toEqual({ cmd: 'npm', prefix: [], shell: false });
  });

  it('honours STAGECHECK_NPM', () => {
    expect(resolveNpm('win32', { STAGECHECK_NPM: '/x/fake.mjs' }, '/node')).toEqual({ cmd: '/node', prefix: ['/x/fake.mjs'], shell: false });
    expect(resolveNpm('linux', { STAGECHECK_NPM: '/x/npm' })).toEqual({ cmd: '/x/npm', prefix: [], shell: false });
  });

  // Creating symlinks needs extra privileges on Windows itself.
  it.skipIf(process.platform === 'win32')('on Windows, picks the same npm that npm.cmd would, without a shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'stagecheck-npm-'));
    dirs.push(root);
    // A Node install with its bundled npm, and a newer npm in the global prefix.
    const node = join(root, 'nodejs', 'node');
    mkdirSync(join(root, 'nodejs'));
    symlinkSync(process.execPath, node);
    const prefix = join(root, 'AppData', 'npm');
    file(join(root, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-prefix.js'), `console.log(${JSON.stringify(prefix)})`);
    const bundled = file(join(root, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const global = file(join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    expect(resolveNpm('win32', {}, node)).toEqual({ cmd: node, prefix: [global], shell: false });

    // Started through npx: use that npm.
    const viaNpx = file(join(root, 'other', 'npm', 'bin', 'npm-cli.js'));
    file(join(root, 'other', 'npm', 'bin', 'npx-cli.js'));
    expect(resolveNpm('win32', { npm_execpath: join(root, 'other', 'npm', 'bin', 'npx-cli.js') }, node).prefix).toEqual([viaNpx]);
    // ...but not yarn's or pnpm's.
    expect(resolveNpm('win32', { npm_execpath: join(root, 'yarn.js') }, node).prefix).toEqual([global]);

    rmSync(global);
    expect(resolveNpm('win32', {}, node).prefix).toEqual([bundled]);

    rmSync(bundled);
    expect(resolveNpm('win32', {}, node)).toEqual({ cmd: 'npm.cmd', prefix: [], shell: true });
  });
});

describe('versions and specs', () => {
  it('orders versions, prereleases first', () => {
    expect(compareVersions('1.2.3', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('finds the nearest lower published version, ignoring the staging placeholder', () => {
    const versions = ['0.0.0-stage', '1.0.0', '1.1.0', '2.0.0', '1.1.1'];
    expect(previousVersion(versions, '1.2.0')).toBe('1.1.1');
    expect(previousVersion(versions, '1.0.0')).toBeNull();
    expect(previousVersion(['0.0.0-stage'], '0.1.0')).toBeNull();
  });

  it('accepts only plain package specs', () => {
    expect(assertSpec('@scope/pkg@1.2.3')).toBe('@scope/pkg@1.2.3');
    expect(assertSpec('pkg@next')).toBe('pkg@next');
    for (const bad of ['pkg; rm -rf /', '--registry=https://evil.example', 'git+https://x/y.git', '../local', 'pkg@1.0.0 && x']) {
      expect(() => assertSpec(bad)).toThrow();
    }
  });
});
