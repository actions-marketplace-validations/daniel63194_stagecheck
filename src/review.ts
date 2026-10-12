import { diffFiles, diffManifests, type FileChange, type Manifest, type ManifestDiff } from './diff.js';
import { runRules, type Finding, type Severity } from './rules.js';
import { readTarball, type TarFile } from './tar.js';

export interface Review {
  /** Package name from the new package.json. */
  readonly name: string;
  /** Version being compared against, or `null` for a first release. */
  readonly from: string | null;
  readonly to: string;
  readonly stagedBy?: string;
  readonly files: {
    readonly added: number;
    readonly removed: number;
    readonly modified: number;
    readonly unchanged: number;
    readonly changes: readonly FileChange[];
  };
  readonly size: { readonly before: number | null; readonly after: number };
  readonly manifest: ManifestDiff;
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<Severity, number>>;
  /** Findings left out because they matched an `ignore` entry. */
  readonly ignored: number;
}

export interface ReviewOptions {
  /** Who staged the new version, e.g. `alice` or `github-actions (oidc)`. */
  stagedBy?: string;
  /** Who published the previous version, to detect a change of publisher. */
  previousPublisher?: string;
  /**
   * Findings to leave out: `rule` ignores a rule everywhere, `rule:path` only
   * in matching files. Paths may use `*` (within a folder) and `**` (across
   * folders), e.g. `child-process:dist/**`.
   */
  ignore?: readonly string[];
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Builds a predicate from `ignore` entries; throws on malformed entries. */
export function ignoreMatcher(entries: readonly string[]): (finding: Finding) => boolean {
  const parsed = entries.map((entry) => {
    const colon = entry.indexOf(':');
    const rule = colon === -1 ? entry : entry.slice(0, colon);
    const path = colon === -1 ? null : entry.slice(colon + 1);
    if (!/^[a-z][a-z0-9-]*$/.test(rule) || path === '') throw new Error(`Invalid ignore entry "${entry}" (expected rule or rule:path)`);
    return { rule, path: path === null ? null : globToRegExp(path) };
  });
  return (f) => parsed.some((p) => p.rule === f.rule && (p.path === null || (f.file !== undefined && p.path.test(f.file))));
}

function readManifest(files: ReadonlyMap<string, TarFile>): Manifest | null {
  const file = files.get('package.json');
  if (!file) return null;
  try {
    const value: unknown = JSON.parse(file.data.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Manifest) : null;
  } catch {
    return null;
  }
}

const total = (files: ReadonlyMap<string, TarFile>): number => [...files.values()].reduce((n, f) => n + f.data.length, 0);

/**
 * Compares two versions of a package (as file maps) and reports what changed
 * and which changes look risky. Pass `null` as `before` for a first release.
 */
export function reviewFiles(
  before: ReadonlyMap<string, TarFile> | null,
  after: ReadonlyMap<string, TarFile>,
  options: ReviewOptions = {},
): Review {
  const newManifest = readManifest(after);
  const oldManifest = before ? readManifest(before) : null;
  const manifest = diffManifests(oldManifest, newManifest ?? {});
  const changes = diffFiles(before ?? new Map(), after);
  const findings = runRules({
    oldFiles: before,
    newFiles: after,
    changes,
    manifest,
    newManifest: newManifest ?? {},
    stagedBy: options.stagedBy,
    previousPublisher: options.previousPublisher,
  });
  if (!newManifest) {
    findings.unshift({ rule: 'manifest', severity: 'high', file: 'package.json', message: 'is missing or not valid JSON' });
  }
  const isIgnored = ignoreMatcher(options.ignore ?? []);
  const kept = findings.filter((f) => !isIgnored(f));

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of kept) counts[f.severity]++;
  const count = (s: FileChange['status']): number => changes.filter((c) => c.status === s).length;
  const unchanged = after.size - count('added') - count('modified');

  return {
    name: manifest.name,
    from: manifest.oldVersion,
    to: manifest.newVersion,
    ...(options.stagedBy ? { stagedBy: options.stagedBy } : {}),
    files: { added: count('added'), removed: count('removed'), modified: count('modified'), unchanged, changes },
    size: { before: before ? total(before) : null, after: total(after) },
    manifest,
    findings: kept,
    counts,
    ignored: findings.length - kept.length,
  };
}

/** Like {@link reviewFiles}, starting from two tarballs (`.tgz` bytes). */
export function reviewTarballs(before: Uint8Array | null, after: Uint8Array, options: ReviewOptions = {}): Review {
  return reviewFiles(before ? readTarball(before) : null, readTarball(after), options);
}

/** The most severe level present, or `null` when there are no findings. */
export function worstSeverity(review: Review): Severity | null {
  if (review.counts.high > 0) return 'high';
  if (review.counts.medium > 0) return 'medium';
  if (review.counts.low > 0) return 'low';
  return null;
}

/** Whether a review should fail a check run with `--fail-on <level>`. */
export function failsAt(review: Review, level: Severity | 'none'): boolean {
  if (level === 'none') return false;
  if (level === 'low') return review.findings.length > 0;
  if (level === 'medium') return review.counts.high + review.counts.medium > 0;
  return review.counts.high > 0;
}
