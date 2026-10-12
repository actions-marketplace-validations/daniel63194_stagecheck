import { isEmpty, type MapDiff } from './diff.js';
import { formatBytes, type Finding, type Severity } from './rules.js';
import type { Review } from './review.js';

// Control characters (including terminal escape sequences) and bidirectional
// overrides ("Trojan Source") in package content could hide or reorder findings.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Makes text from a package safe to print: unsafe characters become `\uXXXX`. */
export function displaySafe(text: string): string {
  return text.replace(UNSAFE, (ch) => (ch === '\t' ? ' ' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

const ICON: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '⚪' };
const LABEL: Record<Severity, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'low' };

function sizeLine(r: Review): string {
  const after = formatBytes(r.size.after);
  if (r.size.before === null) return after;
  const pct = r.size.before === 0 ? 0 : Math.round(((r.size.after - r.size.before) / r.size.before) * 100);
  return `${formatBytes(r.size.before)} → ${after} (${pct >= 0 ? '+' : ''}${pct}%)`;
}

function title(r: Review): string {
  return r.from === null ? `${r.name} ${r.to} (first release)` : `${r.name} ${r.from} → ${r.to}`;
}

function dependencySummary(r: Review): string[] {
  const out: string[] = [];
  for (const [field, d] of Object.entries(r.manifest.dependencies) as [string, MapDiff][]) {
    if (isEmpty(d)) continue;
    const parts = [
      ...Object.entries(d.added).map(([k, v]) => `+${k}@${v}`),
      ...Object.entries(d.removed).map(([k]) => `-${k}`),
      ...Object.entries(d.changed).map(([k, v]) => `${k} ${v.from} → ${v.to}`),
    ];
    const shown = parts.slice(0, 6).join(', ') + (parts.length > 6 ? `, +${parts.length - 6} more` : '');
    out.push(`${field}: ${shown}`);
  }
  return out;
}

function verdict(r: Review): string {
  if (r.counts.high > 0) return `${r.counts.high} high-risk finding${r.counts.high === 1 ? '' : 's'}: review carefully before approving.`;
  if (r.counts.medium > 0) return 'No high-risk findings. A few changes are worth a look.';
  return 'No red flags found.';
}

export interface TextOptions {
  /** Use ANSI colours. */
  color?: boolean;
  /** List every changed file, not just a count. */
  verbose?: boolean;
}

/** A report for the terminal. */
export function renderText(r: Review, options: TextOptions = {}): string {
  const c = (code: number, s: string): string => (options.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const sev: Record<Severity, (s: string) => string> = {
    high: (s) => c(31, s),
    medium: (s) => c(33, s),
    low: (s) => c(90, s),
  };
  const s = displaySafe;
  const lines: string[] = [];
  lines.push(c(1, s(title(r))) + (r.stagedBy ? `  ${c(90, `staged by ${s(r.stagedBy)}`)}` : ''));
  lines.push(`  files: ${r.files.added} added, ${r.files.modified} modified, ${r.files.removed} removed · size ${sizeLine(r)}`);
  for (const d of dependencySummary(r)) lines.push(`  ${s(d)}`);
  if (options.verbose) {
    for (const ch of r.files.changes) lines.push(c(90, `    ${ch.status === 'added' ? '+' : ch.status === 'removed' ? '-' : '~'} ${s(ch.path)}`));
  }
  lines.push('');
  if (r.findings.length === 0) {
    lines.push(c(32, '  ✓ No red flags found.'));
  } else {
    for (const f of r.findings) {
      lines.push(`  ${sev[f.severity](LABEL[f.severity].padEnd(6))} ${f.file ? `${c(1, s(f.file))} ` : ''}${s(f.message)}${f.occurrences ? c(90, ` (×${f.occurrences})`) : ''}`);
      if (f.evidence) lines.push(c(90, `         ${s(f.evidence)}`));
    }
    lines.push('');
    lines.push(`  ${r.counts.high > 0 ? sev.high(verdict(r)) : verdict(r)}`);
  }
  if (r.ignored > 0) lines.push(c(90, `  ${r.ignored} finding${r.ignored === 1 ? '' : 's'} ignored by --ignore.`));
  return lines.join('\n');
}

const escapeMd = (s: string): string => displaySafe(s).replace(/[\\`*_[\]<>|#!~]/g, (ch) => `\\${ch}`);
const code = (s: string): string => `\`${displaySafe(s).replace(/`/g, "'")}\``;
/** A code span inside a table cell, where `|` must be escaped even in code. */
const cellCode = (s: string): string => code(s).replace(/\|/g, '\\|');

/** A report for GitHub (job summaries, issues, pull request comments). */
export function renderMarkdown(r: Review, extra: { approveCommand?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`### stagecheck: ${escapeMd(title(r))}`);
  lines.push('');
  const status = r.counts.high > 0 ? '🔴' : r.counts.medium > 0 ? '🟠' : '🟢';
  lines.push(`${status} **${verdict(r)}**`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  if (r.stagedBy) lines.push(`| Staged by | ${escapeMd(r.stagedBy)} |`);
  lines.push(`| Files | ${r.files.added} added, ${r.files.modified} modified, ${r.files.removed} removed |`);
  lines.push(`| Size | ${sizeLine(r)} |`);
  const deps = dependencySummary(r);
  lines.push(`| Dependencies | ${deps.length ? escapeMd(deps.join('; ')) : 'no changes'} |`);
  if (r.ignored > 0) lines.push(`| Ignored | ${r.ignored} finding${r.ignored === 1 ? '' : 's'} (--ignore) |`);
  lines.push('');
  if (r.findings.length > 0) {
    lines.push('| Severity | Where | Finding |');
    lines.push('| --- | --- | --- |');
    for (const f of r.findings) {
      const what = escapeMd(f.message) + (f.occurrences ? ` (×${f.occurrences})` : '') + (f.evidence ? `<br>${cellCode(f.evidence.slice(0, 200))}` : '');
      lines.push(`| ${ICON[f.severity]} ${LABEL[f.severity]} | ${f.file ? cellCode(f.file) : ''} | ${what} |`);
    }
    lines.push('');
  }
  if (r.files.changes.length > 0) {
    lines.push('<details><summary>Changed files</summary>');
    lines.push('');
    for (const ch of r.files.changes.slice(0, 300)) {
      const sym = ch.status === 'added' ? '➕' : ch.status === 'removed' ? '➖' : '✏️';
      lines.push(`- ${sym} ${code(ch.path)}`);
    }
    if (r.files.changes.length > 300) lines.push(`- …and ${r.files.changes.length - 300} more`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (extra.approveCommand) {
    lines.push('After reviewing, approve it from your machine (requires 2FA):');
    lines.push('');
    lines.push('```sh');
    lines.push(extra.approveCommand);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/** Machine-readable output. */
export function renderJson(reviews: readonly Review[] | Review): string {
  return JSON.stringify(reviews, null, 2);
}

export type { Finding };
