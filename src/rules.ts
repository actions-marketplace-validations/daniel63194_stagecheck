import { addedLines, DEPENDENCY_FIELDS, isEmpty, type FileChange, type Manifest, type ManifestDiff } from './diff.js';
import { isBinary, type TarFile } from './tar.js';

export type Severity = 'high' | 'medium' | 'low';
export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];

export interface Finding {
  /** Stable rule id, e.g. `install-script`. */
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  readonly file?: string;
  /** The offending line (trimmed) or value. */
  readonly evidence?: string;
  /** How many times the pattern matched in this file, when more than once. */
  readonly occurrences?: number;
}

export interface RuleContext {
  readonly oldFiles: ReadonlyMap<string, TarFile> | null;
  readonly newFiles: ReadonlyMap<string, TarFile>;
  readonly changes: readonly FileChange[];
  readonly manifest: ManifestDiff;
  readonly newManifest: Manifest;
  readonly stagedBy?: string | undefined;
  readonly previousPublisher?: string | undefined;
}

/** npm runs these automatically on `npm install`. */
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl)$/i;

/** TypeScript declaration files describe types and never run. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

function isCodeFile(path: string, data: Buffer): boolean {
  if (DECLARATION_FILE.test(path)) return false;
  if (CODE_FILE.test(path)) return true;
  const base = path.split('/').pop() ?? '';
  return !base.includes('.') && data.length > 2 && data[0] === 0x23 && data[1] === 0x21; // "#!" script
}

interface LinePattern {
  readonly rule: string;
  readonly severity: Severity;
  readonly pattern: RegExp;
  readonly message: string;
}

/** Patterns checked against the lines a release adds to code files. */
export const LINE_PATTERNS: readonly LinePattern[] = [
  {
    rule: 'credential-access',
    severity: 'high',
    pattern:
      /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|CI_JOB_TOKEN)\b|\.npmrc\b|\.ssh[\\/](?:id_|authorized_keys)|\.aws[\\/]credentials|\.git-credentials|\.docker[\\/]config\.json|\btrufflehog\b|JSON\.stringify\(\s*process\.env\s*\)/i,
    message: 'reads credentials or credential files',
  },
  {
    rule: 'exfiltration-endpoint',
    severity: 'high',
    pattern:
      /\b(?:webhook\.site|pipedream\.net|requestbin\.(?:com|net)|hookbin\.com|beeceptor\.com|[\w-]+\.ngrok(?:-free)?\.(?:io|app)|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|[\w.-]*\.(?:oast\.(?:fun|live|me|online|pro|site)|interact\.sh|burpcollaborator\.net)|pastebin\.com\/raw|transfer\.sh)/i,
    message: 'contacts a service commonly used to exfiltrate data',
  },
  {
    rule: 'workflow-write',
    severity: 'high',
    pattern: /\.github[\\/]workflows/,
    message: 'references GitHub Actions workflow files (worms such as Shai-Hulud plant workflows)',
  },
  {
    rule: 'self-publish',
    severity: 'high',
    pattern: /\bnpm\s+(?:publish|whoami|adduser|login|token\s+create)\b|registry\.npmjs\.org\/-\/(?:whoami|user|npm\/v1\/tokens)/,
    message: 'runs npm account or publish commands from shipped code (self-propagating worms do this)',
  },
  {
    rule: 'pipe-to-shell',
    severity: 'high',
    pattern: /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:ba|z)?sh\b|\b(?:iex|Invoke-Expression)\b|powershell(?:\.exe)?\s[^\n]{0,60}-(?:e|enc|encodedcommand)\b/i,
    message: 'downloads and executes a script',
  },
  {
    rule: 'github-token',
    severity: 'medium',
    pattern: /\b(?:GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT)\b/,
    message: 'reads a GitHub token',
  },
  {
    rule: 'child-process',
    severity: 'medium',
    pattern: /\bchild_process\b|\b(?:execSync|execFileSync|spawnSync)\s*\(/,
    message: 'starts other programs',
  },
  {
    rule: 'dynamic-code',
    severity: 'medium',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn(?:New|This)?Context|Script)\b/,
    message: 'evaluates code built at runtime',
  },
  {
    rule: 'base64-blob',
    severity: 'medium',
    // A data: URI's base64 run follows a comma, not a quote, so data URIs never match.
    pattern: /["'`][A-Za-z0-9+/]{2000,}={0,2}["'`]/,
    message: 'contains a large base64-encoded string',
  },
];

const OBFUSCATED_IDENTIFIER = /\b_0x[0-9a-f]{4,6}\b/gi;
const HEX_ESCAPE = /\\x[0-9a-f]{2}/gi;
const URL_HOST = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const COMMON_HOSTS =
  /(?:^|\.)(?:github\.com|githubusercontent\.com|npmjs\.(?:com|org)|nodejs\.org|w3\.org|whatwg\.org|mozilla\.org|json-schema\.org|schema\.org|example\.(?:com|org|net)|localhost|opensource\.org|semver\.org|unicode\.org|ietf\.org|rfc-editor\.org|typescriptlang\.org|microsoft\.com|google\.com|apache\.org|creativecommons\.org)$/i;

function evidenceOf(line: string, match: RegExpExecArray | null): string {
  const text = line.trim();
  if (text.length <= 160 || !match) return text.slice(0, 160);
  const at = Math.max(0, line.indexOf(match[0]) - 60);
  return `…${line.slice(at, at + 150).trim()}…`;
}

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

function longestLine(text: string): number {
  let max = 0;
  for (const line of text.split('\n')) if (line.length > max) max = line.length;
  return max;
}

/** Lines matching `pattern` across every code file of a package. */
function countMatches(files: ReadonlyMap<string, TarFile>, pattern: RegExp): number {
  let n = 0;
  for (const file of files.values()) {
    if (file.data.length > 50_000_000 || isBinary(file.data) || !isCodeFile(file.path, file.data)) continue;
    for (const line of file.data.toString('utf8').split('\n')) if (pattern.test(line)) n++;
  }
  return n;
}

const EXECUTABLE_EXTENSION = /\.(?:node|exe|dll|so|dylib)$/i;

function binaryKind(path: string, data: Buffer): 'executable' | 'wasm' | null {
  if (EXECUTABLE_EXTENSION.test(path)) return 'executable';
  if (data.length < 4) return null;
  const magic = data.readUInt32BE(0);
  if (magic === 0x7f454c46) return 'executable'; // ELF
  if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'executable'; // Mach-O
  if (data[0] === 0x4d && data[1] === 0x5a && data.length > 0x40) {
    const pe = data.readUInt32LE(0x3c);
    if (pe + 4 <= data.length && data.readUInt32BE(pe) === 0x50450000) return 'executable'; // PE
  }
  if (magic === 0x0061736d) return 'wasm'; // "\0asm"
  return null;
}

const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519|ecdsa|dsa)|credentials\.json|[\w.-]+\.(?:pem|key|p12|pfx))$/i;

function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) hosts.add((m[1] as string).toLowerCase());
  return hosts;
}

const DEPENDENCY_LABEL: Record<(typeof DEPENDENCY_FIELDS)[number], [string, string]> = {
  dependencies: ['dependency', 'dependencies'],
  optionalDependencies: ['optional dependency', 'optional dependencies'],
  peerDependencies: ['peer dependency', 'peer dependencies'],
};

const NON_REGISTRY_SPEC = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i;

function parseSemver(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Applies every rule and returns the findings, most severe first. */
export function runRules(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Finding): void => void findings.push(f);
  const m = ctx.manifest;

  // ── package.json ────────────────────────────────────────────────────────
  for (const name of INSTALL_SCRIPTS) {
    if (name in m.scripts.added) {
      add({ rule: 'install-script', severity: 'high', file: 'package.json', message: `adds a "${name}" script, which runs automatically on install`, evidence: m.scripts.added[name] as string });
    } else if (name in m.scripts.changed) {
      const c = m.scripts.changed[name] as { from: string; to: string };
      add({ rule: 'install-script', severity: 'high', file: 'package.json', message: `changes the "${name}" script, which runs automatically on install`, evidence: `${c.from} → ${c.to}` });
    }
  }

  // Files that an unchanged install script runs, but whose contents changed.
  const scripts = (ctx.newManifest.scripts ?? {}) as Record<string, unknown>;
  for (const name of INSTALL_SCRIPTS) {
    const command = scripts[name];
    if (typeof command !== 'string' || name in m.scripts.added || name in m.scripts.changed) continue;
    for (const token of command.split(/[\s;&|()'"]+/)) {
      const path = token.replace(/^\.\//, '');
      const change = ctx.changes.find((c) => c.path === path && c.status !== 'removed');
      if (change) {
        add({ rule: 'install-script-target', severity: 'medium', file: path, message: `is run by the "${name}" script and was ${change.status}` });
      }
    }
  }

  if (ctx.changes.some((c) => c.path === 'binding.gyp' && c.status === 'added') && !INSTALL_SCRIPTS.some((s) => typeof scripts[s] === 'string')) {
    add({ rule: 'native-build', severity: 'medium', file: 'binding.gyp', message: 'adds binding.gyp, so npm will compile native code on install' });
  }

  for (const field of DEPENDENCY_FIELDS) {
    const d = m.dependencies[field];
    for (const [name, spec] of Object.entries({ ...d.added, ...Object.fromEntries(Object.entries(d.changed).map(([k, v]) => [k, v.to])) })) {
      if (NON_REGISTRY_SPEC.test(spec)) {
        add({ rule: 'dependency-source', severity: 'high', file: 'package.json', message: `${field}: "${name}" is installed from outside the npm registry`, evidence: spec });
      } else if (/^npm:/i.test(spec)) {
        add({ rule: 'dependency-alias', severity: 'medium', file: 'package.json', message: `${field}: "${name}" is an alias for a different package`, evidence: spec });
      }
    }
    const added = Object.entries(d.added).filter(([, spec]) => !NON_REGISTRY_SPEC.test(spec));
    if (added.length > 0) {
      add({
        rule: 'dependency-added',
        severity: field === 'peerDependencies' ? 'low' : 'medium',
        file: 'package.json',
        message: `adds ${added.length} new ${DEPENDENCY_LABEL[field][added.length === 1 ? 0 : 1]}`,
        evidence: added.map(([k, v]) => `${k}@${v}`).join(', '),
      });
    }
  }

  if (!isEmpty(m.bin)) {
    const parts = [
      ...Object.entries(m.bin.added).map(([k, v]) => `+${k} → ${v}`),
      ...Object.entries(m.bin.changed).map(([k, v]) => `${k}: ${v.from} → ${v.to}`),
    ];
    if (parts.length > 0) add({ rule: 'bin-change', severity: 'medium', file: 'package.json', message: 'adds or changes command-line programs installed on users\' PATH', evidence: parts.join(', ') });
  }

  const entry = Object.keys(m.entryPoints).filter((k) => k !== 'files');
  if (m.oldVersion !== null && entry.length > 0) {
    add({ rule: 'entry-points', severity: 'low', file: 'package.json', message: `changes ${entry.map((k) => `"${k}"`).join(', ')}` });
  }

  if (m.oldVersion !== null) {
    const a = parseSemver(m.oldVersion);
    const b = parseSemver(m.newVersion);
    if (a && b && (b[0]! < a[0]! || (b[0] === a[0] && (b[1]! < a[1]! || (b[1] === a[1] && b[2]! <= a[2]!))))) {
      add({ rule: 'version-order', severity: 'low', message: `version ${m.newVersion} is not newer than ${m.oldVersion}` });
    }
  }

  // "github-actions (oidc)" and "GitHub Actions" are the same publisher.
  const who = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ctx.stagedBy && ctx.previousPublisher && who(ctx.stagedBy) !== who(ctx.previousPublisher)) {
    add({ rule: 'publisher-change', severity: 'medium', message: `staged by ${ctx.stagedBy}, but the previous version was published by ${ctx.previousPublisher}` });
  }

  // ── files ───────────────────────────────────────────────────────────────
  let oldHasMinified = false;
  let oldHosts: Set<string> | null = null;
  const oldBinaries = new Set<'executable' | 'wasm'>();
  if (ctx.oldFiles) {
    oldHosts = new Set();
    for (const file of ctx.oldFiles.values()) {
      const kind = binaryKind(file.path, file.data);
      if (kind) oldBinaries.add(kind);
      if (file.data.length > 0 && file.data.length < 20_000_000 && !file.data.includes(0)) {
        const text = file.data.toString('utf8');
        for (const h of hostsIn(text)) oldHosts.add(h);
        if (isCodeFile(file.path, file.data) && longestLine(text) > 5000) oldHasMinified = true;
      }
    }
  }
  const newHosts = new Map<string, string>(); // host → first file
  const candidates: { pattern: LinePattern; finding: Finding }[] = [];
  const obfuscation: { file: string; obfuscated: number; escapes: number; before: string; after: string }[] = [];

  for (const change of ctx.changes) {
    if (change.status === 'removed') continue;
    const file = ctx.newFiles.get(change.path);
    if (!file) continue;

    if (change.status === 'added' && SENSITIVE_FILE.test(change.path)) {
      add({ rule: 'sensitive-file', severity: 'high', file: change.path, message: 'looks like a secrets or key file and is now published with the package' });
    }

    // Packages that ship binaries rebuild them every release, so a changed binary
    // is only alarming in a package that never had one.
    const kind = binaryKind(change.path, file.data);
    const verb = change.status === 'added' ? 'adds' : 'changes';
    if (kind === 'executable') {
      if (ctx.oldFiles && !oldBinaries.has('executable')) {
        add({ rule: 'binary-executable', severity: 'high', file: change.path, message: `${verb} a compiled executable or native module; earlier versions had none` });
      } else {
        add({ rule: 'binary-executable', severity: 'medium', file: change.path, message: `${verb} a compiled executable or native module, which stagecheck cannot inspect: check it came from your build` });
      }
      continue;
    }
    if (kind === 'wasm') {
      const severity = ctx.oldFiles && !oldBinaries.has('wasm') ? 'medium' : 'low';
      add({ rule: 'binary-wasm', severity, file: change.path, message: `${verb} a WebAssembly module${severity === 'medium' ? '; earlier versions had none' : ''}` });
      continue;
    }
    if (change.binary || !isCodeFile(change.path, file.data)) continue;

    const after = file.data.toString('utf8');
    const beforeFile = change.status === 'modified' ? ctx.oldFiles?.get(change.path) : undefined;
    const before = beforeFile ? beforeFile.data.toString('utf8') : '';
    const lines = addedLines(before, after);
    const added = lines.join('\n');

    for (const p of LINE_PATTERNS) {
      let first: string | undefined;
      let count = 0;
      for (const line of lines) {
        const match = p.pattern.exec(line);
        if (match) {
          count++;
          first ??= evidenceOf(line, match);
        }
      }
      if (count > 0) {
        candidates.push({
          pattern: p,
          finding: { rule: p.rule, severity: p.severity, file: change.path, message: p.message, ...(first ? { evidence: first } : {}), ...(count > 1 ? { occurrences: count } : {}) },
        });
      }
    }

    const obfuscated = count(added, OBFUSCATED_IDENTIFIER);
    const escapes = count(added, HEX_ESCAPE);
    if (obfuscated >= 20 || escapes >= 200) obfuscation.push({ file: change.path, obfuscated, escapes, before, after });

    const newLongest = longestLine(added);
    if (newLongest > 5000) {
      if (change.status === 'modified' && longestLine(before) < 500) {
        add({ rule: 'minified-injection', severity: 'medium', file: change.path, message: `a readable file gained a ${newLongest.toLocaleString('en')}-character line (possible injected payload)` });
      } else if (change.status === 'added' && ctx.oldFiles && !oldHasMinified) {
        add({ rule: 'new-minified-file', severity: 'medium', file: change.path, message: 'adds minified or bundled code; earlier versions had none' });
      }
    }

    if (oldHosts) {
      for (const host of hostsIn(added)) {
        if (!oldHosts.has(host) && !COMMON_HOSTS.test(host) && !newHosts.has(host)) newHosts.set(host, change.path);
      }
    }
  }

  // Line patterns only describe what a release *introduces*. Compared with the
  // previous version as a whole (which also handles renamed or re-bundled files):
  // a medium/low capability is reported only if the package never had it, and a
  // high-risk pattern only if it now matches on more lines than before.
  if (!ctx.oldFiles) {
    for (const c of candidates) add(c.finding);
  } else {
    const oldCounts = new Map<string, number>();
    const newCounts = new Map<string, number>();
    const cached = (cache: Map<string, number>, files: ReadonlyMap<string, TarFile>, p: LinePattern): number => {
      let n = cache.get(p.rule);
      if (n === undefined) {
        n = countMatches(files, p.pattern);
        cache.set(p.rule, n);
      }
      return n;
    };
    for (const { pattern, finding } of candidates) {
      const before = cached(oldCounts, ctx.oldFiles, pattern);
      if (pattern.severity === 'high' ? cached(newCounts, ctx.newFiles, pattern) > before : before === 0) add(finding);
    }
  }

  // Regenerated bundles (parsers, compiled grammars) legitimately carry thousands
  // of hex escapes. Count only net growth, in the file and in the package.
  if (obfuscation.length > 0) {
    const totals = (files: ReadonlyMap<string, TarFile>): [number, number] => {
      let ob = 0;
      let esc = 0;
      for (const f of files.values()) {
        if (f.data.length > 50_000_000 || isBinary(f.data) || !isCodeFile(f.path, f.data)) continue;
        const text = f.data.toString('utf8');
        ob += count(text, OBFUSCATED_IDENTIFIER);
        esc += count(text, HEX_ESCAPE);
      }
      return [ob, esc];
    };
    let growth: [number, number] | null = null;
    if (ctx.oldFiles) {
      const [newOb, newEsc] = totals(ctx.newFiles);
      const [oldOb, oldEsc] = totals(ctx.oldFiles);
      growth = [newOb - oldOb, newEsc - oldEsc];
    }
    for (const o of obfuscation) {
      let { obfuscated, escapes } = o;
      if (growth) {
        obfuscated = Math.min(obfuscated, count(o.after, OBFUSCATED_IDENTIFIER) - count(o.before, OBFUSCATED_IDENTIFIER), growth[0]);
        escapes = Math.min(escapes, count(o.after, HEX_ESCAPE) - count(o.before, HEX_ESCAPE), growth[1]);
      }
      if (obfuscated >= 20) add({ rule: 'obfuscation', severity: 'high', file: o.file, message: `adds ${obfuscated} obfuscator-style identifiers (_0x…)` });
      else if (escapes >= 200) add({ rule: 'obfuscation', severity: 'high', file: o.file, message: `adds ${escapes} hex-escaped characters, typical of obfuscated code` });
    }
  }

  if (newHosts.size > 0) {
    const list = [...newHosts.keys()].sort();
    add({ rule: 'new-domains', severity: 'low', message: `contacts ${list.length} domain${list.length === 1 ? '' : 's'} not referenced by the previous version`, evidence: list.slice(0, 10).join(', ') + (list.length > 10 ? `, +${list.length - 10} more` : '') });
  }

  const sizeOf = (files: ReadonlyMap<string, TarFile>): number => [...files.values()].reduce((n, f) => n + f.data.length, 0);
  if (ctx.oldFiles) {
    const before = sizeOf(ctx.oldFiles);
    const after = sizeOf(ctx.newFiles);
    if (after > before * 2 && after - before > 500_000) {
      add({ rule: 'size-jump', severity: 'medium', message: `unpacked size grew from ${formatBytes(before)} to ${formatBytes(after)}` });
    }
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
