import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface NpmResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NpmCommand {
  readonly cmd: string;
  readonly prefix: readonly string[];
  readonly shell: boolean;
}

/**
 * Finds the npm a Windows user gets when they type `npm`, as npm's own
 * `npm.cmd` does: a newer npm installed in the global prefix (for example by
 * `npm install -g npm@latest`) wins over the one bundled with Node.
 */
function windowsNpmCli(env: NodeJS.ProcessEnv, execPath: string): string | null {
  // Started through npx or an npm script: use that same npm.
  const execpath = env.npm_execpath;
  if (execpath && /[\\/]np[mx]-cli\.js$/i.test(execpath)) {
    const cli = join(dirname(execpath), 'npm-cli.js');
    if (existsSync(cli)) return cli;
  }
  const bundled = join(dirname(execPath), 'node_modules', 'npm', 'bin');
  const prefixScript = join(bundled, 'npm-prefix.js');
  if (existsSync(prefixScript)) {
    try {
      const prefix = execFileSync(execPath, [prefixScript], { encoding: 'utf8', env, windowsHide: true, timeout: 15_000 }).trim();
      const cli = join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (prefix && existsSync(cli)) return cli;
    } catch {
      // fall through to the bundled npm
    }
  }
  const cli = join(bundled, 'npm-cli.js');
  return existsSync(cli) ? cli : null;
}

/**
 * How to launch npm, without a shell where possible. On Windows, Node refuses
 * to spawn `npm.cmd` without a shell, so we run npm's JavaScript entry point
 * with the current Node binary instead. `STAGECHECK_NPM` overrides the npm
 * executable (used by the tests).
 */
export function resolveNpm(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): NpmCommand {
  const override = env.STAGECHECK_NPM;
  if (override) {
    return /\.[cm]?js$/.test(override) ? { cmd: execPath, prefix: [override], shell: false } : { cmd: override, prefix: [], shell: false };
  }
  if (platform !== 'win32') return { cmd: 'npm', prefix: [], shell: false };
  const cli = windowsNpmCli(env, execPath);
  return cli ? { cmd: execPath, prefix: [cli], shell: false } : { cmd: 'npm.cmd', prefix: [], shell: true };
}

let resolved: NpmCommand | undefined;
const npmCommand = (): NpmCommand => (resolved ??= resolveNpm());

// Only used in the Windows shell fallback: anything cmd.exe could interpret is refused.
const SHELL_SAFE = /^[\w@./:=+-]+$/;

function quoteForShell(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  if (/["%^&|<>!\r\n]/.test(arg)) throw new Error(`Refusing to pass ${JSON.stringify(arg)} through the shell`);
  return `"${arg}"`;
}

export interface RunOptions {
  cwd?: string;
  /** Connect npm to this terminal (for 2FA prompts) instead of capturing output. */
  interactive?: boolean;
}

/** Runs npm with the given arguments. Never throws on a non-zero exit code. */
export function runNpm(args: readonly string[], options: RunOptions = {}): Promise<NpmResult> {
  const { cmd, prefix, shell } = npmCommand();
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    windowsHide: true,
  };
  return new Promise((resolve, reject) => {
    // With a shell, pass one pre-quoted command line: Node does not quote an
    // args array for the shell (and that form is deprecated).
    const child: ChildProcess = shell
      ? spawn([cmd, ...prefix, ...args].map(quoteForShell).join(' '), { ...spawnOptions, shell: true })
      : spawn(cmd, [...prefix, ...args], { ...spawnOptions, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export class NpmError extends Error {
  constructor(
    message: string,
    readonly result?: NpmResult,
  ) {
    super(message);
  }
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
}

function fail(what: string, r: NpmResult): never {
  const detail = lastLine(r.stderr) || lastLine(r.stdout) || `exit code ${r.code}`;
  throw new NpmError(`${what} failed: ${detail.replace(/^npm (?:error|ERR!)\s*/, '')}`, r);
}

/** A package spec we are willing to pass to npm: a name, optionally @ an exact version or dist-tag. */
const SPEC = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.+-]+)?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSpec(spec: string): string {
  if (!SPEC.test(spec)) throw new Error(`Not a package spec stagecheck accepts: ${JSON.stringify(spec)} (use name, name@version or name@tag)`);
  return spec;
}

export function splitSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null };
}

/** A scratch directory that is deleted by `dispose()`. */
export function scratchDir(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'stagecheck-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

function tarballIn(dir: string): Buffer {
  const name = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!name) throw new Error(`npm did not write a tarball into ${dir}`);
  return readFileSync(join(dir, name));
}

export async function npmVersion(): Promise<string> {
  const r = await runNpm(['--version']);
  if (r.code !== 0) fail('npm --version', r);
  return r.stdout.trim();
}

/** Downloads a published version's tarball (works for private packages too). */
export async function packSpec(spec: string): Promise<Buffer> {
  const dir = scratchDir();
  try {
    const r = await runNpm(['pack', assertSpec(spec), '--silent'], { cwd: dir.path });
    if (r.code !== 0) fail(`npm pack ${spec}`, r);
    return tarballIn(dir.path);
  } finally {
    dir.dispose();
  }
}

/** Packs a local project directory into the tarball that publishing would upload. */
export async function packDirectory(projectDir: string): Promise<Buffer> {
  const dir = scratchDir();
  try {
    const r = await runNpm(['pack', '--silent', '--pack-destination', dir.path], { cwd: projectDir });
    if (r.code !== 0) fail('npm pack', r);
    return tarballIn(dir.path);
  } finally {
    dir.dispose();
  }
}

export interface PublishedVersion {
  readonly version: string;
  /** npm username of whoever published it, when the registry says. */
  readonly publisher?: string;
}

function publisherName(value: unknown): string | undefined {
  if (typeof value === 'string') return value.replace(/\s*<.*>$/, '').trim() || undefined;
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name;
  return undefined;
}

/** Resolves `name@tagOrVersion`. Returns `null` when the package or version does not exist. */
export async function viewVersion(spec: string): Promise<PublishedVersion | null> {
  const r = await runNpm(['view', assertSpec(spec), 'version', '_npmUser', '--json']);
  if (r.code !== 0) {
    if (/E404|404 Not Found|is not in this registry|No match found/i.test(r.stderr + r.stdout)) return null;
    fail(`npm view ${spec}`, r);
  }
  if (!r.stdout.trim()) return null;
  let data: unknown = JSON.parse(r.stdout);
  if (Array.isArray(data)) data = data[data.length - 1]; // several versions matched: take the newest
  if (typeof data === 'string') return { version: data };
  if (data && typeof data === 'object' && 'version' in data && typeof data.version === 'string') {
    const publisher = publisherName((data as { _npmUser?: unknown })._npmUser);
    return publisher ? { version: data.version, publisher } : { version: data.version };
  }
  return null;
}

/** All published versions of a package, oldest first. */
export async function listVersions(name: string): Promise<string[]> {
  const r = await runNpm(['view', assertSpec(name), 'versions', '--json']);
  if (r.code !== 0) {
    if (/E404/.test(r.stderr + r.stdout)) return [];
    fail(`npm view ${name} versions`, r);
  }
  const data: unknown = JSON.parse(r.stdout || '[]');
  return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : typeof data === 'string' ? [data] : [];
}

export interface StagedItem {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly tag?: string;
  readonly createdAt?: string;
  readonly actor?: string;
  readonly actorType?: string;
  readonly status?: string;
  readonly shasum?: string;
}

function isStagedItem(x: unknown): x is StagedItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && UUID.test(o.id) && typeof o.packageName === 'string' && typeof o.version === 'string';
}

/** Staged versions you can approve (`npm stage list`). */
export async function stageList(packageName?: string): Promise<StagedItem[]> {
  const r = await runNpm(['stage', 'list', ...(packageName ? [assertSpec(packageName)] : []), '--json']);
  if (r.code !== 0) fail('npm stage list', r);
  const data: unknown = JSON.parse(r.stdout || '[]');
  return Array.isArray(data) ? data.filter(isStagedItem) : [];
}

/** Downloads a staged version's tarball (`npm stage download`). */
export async function stageDownload(id: string): Promise<Buffer> {
  if (!UUID.test(id)) throw new Error(`Not a stage id: ${id}`);
  const dir = scratchDir();
  try {
    const r = await runNpm(['stage', 'download', id], { cwd: dir.path });
    if (r.code !== 0) fail(`npm stage download ${id}`, r);
    return tarballIn(dir.path);
  } finally {
    dir.dispose();
  }
}

/** Approves or rejects a staged version. npm asks for the 2FA code itself. */
export async function stageDecide(action: 'approve' | 'reject', id: string): Promise<boolean> {
  if (!UUID.test(id)) throw new Error(`Not a stage id: ${id}`);
  const r = await runNpm(['stage', action, id], { interactive: true });
  return r.code === 0;
}

/**
 * Stages a tarball (`npm stage publish <file>`), passing extra npm arguments
 * through. Returns the stage id npm printed, if any.
 */
export async function stagePublish(tarballPath: string, extraArgs: readonly string[]): Promise<{ stageId: string | null; output: string }> {
  const r = await runNpm(['stage', 'publish', tarballPath, ...extraArgs]);
  const output = `${r.stdout}${r.stderr}`;
  if (r.code !== 0) fail('npm stage publish', r);
  const match = /staged with id ([0-9a-f-]{36})/i.exec(output);
  return { stageId: match ? (match[1] as string) : null, output };
}

/** Compares two semver versions (prerelease < release). Non-semver sorts last. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], string] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(v);
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])], m[4] ?? ''] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? -1 : y ? 1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (x[0][i] !== y[0][i]) return (x[0][i] as number) - (y[0][i] as number);
  if (x[1] === y[1]) return 0;
  if (!x[1]) return 1;
  if (!y[1]) return -1;
  return x[1].localeCompare(y[1], 'en', { numeric: true });
}

/** The published version immediately before `version` (prereleases only before prereleases). */
export function previousVersion(versions: readonly string[], version: string): string | null {
  const pre = version.includes('-');
  const older = versions.filter((v) => compareVersions(v, version) < 0 && (pre || !v.includes('-')) && v !== '0.0.0-stage');
  return older.sort(compareVersions).pop() ?? null;
}
