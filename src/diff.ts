import { isBinary, type TarFile } from './tar.js';

export type FileStatus = 'added' | 'removed' | 'modified';

export interface FileChange {
  readonly path: string;
  readonly status: FileStatus;
  readonly oldSize?: number;
  readonly newSize?: number;
  readonly binary: boolean;
}

/** Files that differ between two package versions, sorted by path. */
export function diffFiles(oldFiles: ReadonlyMap<string, TarFile>, newFiles: ReadonlyMap<string, TarFile>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, file] of newFiles) {
    const before = oldFiles.get(path);
    if (!before) {
      changes.push({ path, status: 'added', newSize: file.data.length, binary: isBinary(file.data) });
    } else if (!before.data.equals(file.data)) {
      changes.push({ path, status: 'modified', oldSize: before.data.length, newSize: file.data.length, binary: isBinary(file.data) });
    }
  }
  for (const [path, file] of oldFiles) {
    if (!newFiles.has(path)) changes.push({ path, status: 'removed', oldSize: file.data.length, binary: isBinary(file.data) });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Lines present in `after` but not in `before`, compared as multisets (a line
 * that appears twice more often than before is reported twice). Cheap, and
 * good enough to scan only what a release introduced.
 */
export function addedLines(before: string, after: string): string[] {
  const counts = new Map<string, number>();
  for (const line of before.split(/\r?\n/)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split(/\r?\n/)) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  return added;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Manifest = { [key: string]: Json };

export interface MapDiff {
  readonly added: Record<string, string>;
  readonly removed: Record<string, string>;
  readonly changed: Record<string, { from: string; to: string }>;
}

export const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

export interface ManifestDiff {
  readonly name: string;
  readonly oldVersion: string | null;
  readonly newVersion: string;
  readonly scripts: MapDiff;
  readonly dependencies: Record<DependencyField, MapDiff>;
  readonly bin: MapDiff;
  /** `main`, `module`, `exports`, `types`… whose value changed (JSON-encoded). */
  readonly entryPoints: Record<string, { from: string | null; to: string | null }>;
}

/**
 * An object without a prototype, so keys such as "constructor" or "__proto__"
 * (which are valid in package.json) behave like any other key.
 */
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function asStringMap(value: Json | undefined): Record<string, string> {
  const out = record<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

/** `bin` may be a string (one command named after the package) or an object. */
function binMap(manifest: Manifest): Record<string, string> {
  const bin = manifest.bin;
  if (typeof bin === 'string') {
    const name = typeof manifest.name === 'string' ? manifest.name.replace(/^@[^/]+\//, '') : 'bin';
    const out = record<string>();
    out[name] = bin;
    return out;
  }
  return asStringMap(bin);
}

export function diffMaps(before: Record<string, string>, after: Record<string, string>): MapDiff {
  const added = record<string>();
  const removed = record<string>();
  const changed = record<{ from: string; to: string }>();
  for (const [k, v] of Object.entries(after)) {
    if (!Object.hasOwn(before, k)) added[k] = v;
    else if (before[k] !== v) changed[k] = { from: before[k] as string, to: v };
  }
  for (const [k, v] of Object.entries(before)) if (!Object.hasOwn(after, k)) removed[k] = v;
  return { added, removed, changed };
}

const ENTRY_FIELDS = ['main', 'module', 'browser', 'exports', 'types', 'typings', 'imports', 'type', 'files'];

export function diffManifests(before: Manifest | null, after: Manifest): ManifestDiff {
  const old = before ?? {};
  const dependencies = {} as Record<DependencyField, MapDiff>;
  for (const field of DEPENDENCY_FIELDS) {
    dependencies[field] = diffMaps(asStringMap(old[field]), asStringMap(after[field]));
  }
  const entryPoints: ManifestDiff['entryPoints'] = {};
  for (const field of ENTRY_FIELDS) {
    const from = Object.hasOwn(old, field) ? JSON.stringify(old[field]) : null;
    const to = Object.hasOwn(after, field) ? JSON.stringify(after[field]) : null;
    if (from !== to) entryPoints[field] = { from, to };
  }
  return {
    name: typeof after.name === 'string' ? after.name : '(unnamed)',
    oldVersion: before && typeof before.version === 'string' ? before.version : null,
    newVersion: typeof after.version === 'string' ? after.version : '0.0.0',
    scripts: diffMaps(asStringMap(old.scripts), asStringMap(after.scripts)),
    dependencies,
    bin: diffMaps(binMap(old), binMap(after)),
    entryPoints,
  };
}

export function isEmpty(diff: MapDiff): boolean {
  return Object.keys(diff.added).length + Object.keys(diff.removed).length + Object.keys(diff.changed).length === 0;
}
