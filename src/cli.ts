#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  NpmError,
  assertSpec,
  compareVersions,
  listVersions,
  npmVersion,
  packDirectory,
  packSpec,
  previousVersion,
  scratchDir,
  stageDecide,
  stageDownload,
  stageList,
  stagePublish,
  viewVersion,
  type StagedItem,
} from './npm.js';
import { renderJson, renderMarkdown, renderText } from './report.js';
import { failsAt, ignoreMatcher, reviewTarballs, type Review } from './review.js';
import { SEVERITIES, type Severity } from './rules.js';
import { readTarball } from './tar.js';

const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const HELP = `stagecheck ${VERSION} - review npm releases before they go live

Usage:
  stagecheck                      Review your pending staged releases, then approve, reject or skip each
  stagecheck list                 List pending staged releases
  stagecheck review <new>         Compare a version with the one before it
  stagecheck review <old> <new>   Compare two versions
  stagecheck ci                   Pack this project and compare it with the published version (for CI)

<old> and <new> are package specs (name@1.2.3, name@next) or .tgz files.

Options:
  --format <text|markdown|json>   Output format (default: text)
  --fail-on <high|medium|low|none> Exit with code 1 at this severity (default: none; ci: high)
  --tag <tag>                     Dist-tag to compare against (default: latest)
  --ignore <rule[:path]>          Leave out a rule, optionally only for matching files
                                  (glob, e.g. child-process:dist/**); repeatable
  --verbose                       List every changed file
  --no-color                      Plain output
  -h, --help                      Show this help
  -v, --version                   Show the version

ci only:
  --stage-publish                 If the review passes, stage the reviewed tarball with
                                  \`npm stage publish\`; arguments after -- go to npm,
                                  e.g. stagecheck ci --stage-publish -- --provenance
  --summary <file>                Also write the Markdown report to this file
                                  (defaults to $GITHUB_STEP_SUMMARY when set)

Approving or rejecting a staged release asks for your npm 2FA code.
Docs: https://github.com/daniel63194/stagecheck
`;

class UsageError extends Error {}

const useColor = (flag: boolean): boolean => flag && process.stdout.isTTY === true && !process.env.NO_COLOR;

function readTgz(path: string): Buffer {
  return readFileSync(path);
}

const TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;

async function load(arg: string): Promise<Buffer> {
  if (TARBALL.test(arg)) {
    if (!existsSync(arg)) throw new UsageError(`No such file: ${arg}`);
    return readTgz(arg);
  }
  return packSpec(assertSpec(arg));
}

/** The published version to compare `name@version` with, or `null` for a first release. */
async function baselineFor(name: string, version: string, tag: string): Promise<{ spec: string; publisher?: string } | null> {
  const current = await viewVersion(`${name}@${tag}`);
  if (current && current.version !== '0.0.0-stage' && compareVersions(current.version, version) < 0) {
    return { spec: `${name}@${current.version}`, ...(current.publisher ? { publisher: current.publisher } : {}) };
  }
  const prev = previousVersion(await listVersions(name), version);
  if (!prev) return null;
  const info = await viewVersion(`${name}@${prev}`);
  return { spec: `${name}@${prev}`, ...(info?.publisher ? { publisher: info.publisher } : {}) };
}

function manifestOf(tgz: Buffer): { name: string; version: string; tag?: string } {
  const pkg = readTarball(tgz).get('package.json');
  if (!pkg) throw new UsageError('The tarball has no package.json');
  const json = JSON.parse(pkg.data.toString('utf8')) as { name?: string; version?: string; publishConfig?: { tag?: string } };
  if (!json.name || !json.version) throw new UsageError('package.json needs a name and a version');
  return { name: json.name, version: json.version, ...(json.publishConfig?.tag ? { tag: json.publishConfig.tag } : {}) };
}

function output(reviews: Review[], format: string, color: boolean, verbose: boolean): void {
  if (format === 'json') process.stdout.write(`${renderJson(reviews.length === 1 ? (reviews[0] as Review) : reviews)}\n`);
  else if (format === 'markdown') process.stdout.write(`${reviews.map((r) => renderMarkdown(r)).join('\n')}\n`);
  else process.stdout.write(`${reviews.map((r) => renderText(r, { color, verbose })).join('\n\n')}\n`);
}

async function cmdReview(args: string[], opts: Options): Promise<Review> {
  if (args.length === 0 || args.length > 2) throw new UsageError('review needs one or two package specs or .tgz files');
  let before: Buffer | null;
  let after: Buffer;
  let previousPublisher: string | undefined;
  if (args.length === 2) {
    [before, after] = await Promise.all([load(args[0] as string), load(args[1] as string)]);
  } else {
    const arg = args[0] as string;
    after = await load(arg);
    // For a bare name, `after` is the latest version, so this finds the one before it.
    const { name, version } = manifestOf(after);
    const base = await baselineFor(name, version, opts.tag);
    before = base ? await packSpec(base.spec) : null;
    previousPublisher = base?.publisher;
  }
  return reviewTarballs(before, after, { ignore: opts.ignore, ...(previousPublisher ? { previousPublisher } : {}) });
}

async function ensureStageSupport(): Promise<void> {
  const v = await npmVersion();
  if (compareVersions(v, '11.15.0') < 0) {
    throw new UsageError(`Staged publishing needs npm 11.15 or newer (you have ${v}). Update with: npm install -g npm@latest`);
  }
}

const stagedBy = (item: StagedItem): string | undefined =>
  item.actor ? (item.actorType ? `${item.actor} (${item.actorType})` : item.actor) : undefined;

async function reviewStaged(item: StagedItem, opts: Options): Promise<Review> {
  const tag = item.tag || opts.tag;
  const [after, base] = await Promise.all([stageDownload(item.id), baselineFor(item.packageName, item.version, tag)]);
  const before = base ? await packSpec(base.spec) : null;
  const by = stagedBy(item);
  return reviewTarballs(before, after, { ignore: opts.ignore, ...(by ? { stagedBy: by } : {}), ...(base?.publisher ? { previousPublisher: base.publisher } : {}) });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

async function cmdInteractive(opts: Options): Promise<Review[]> {
  await ensureStageSupport();
  const items = (await stageList()).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const text = opts.format === 'text';
  if (items.length === 0) {
    process.stdout.write(text ? 'No staged releases are waiting for approval.\n' : opts.format === 'json' ? '[]\n' : '');
    return [];
  }
  const interactive = process.stdin.isTTY === true && text;
  const reviews: Review[] = [];
  if (text) process.stdout.write(`${items.length} staged release${items.length === 1 ? '' : 's'} waiting for approval.\n\n`);
  for (const item of items) {
    const review = await reviewStaged(item, opts);
    reviews.push(review);
    if (!interactive) continue;
    process.stdout.write(`${renderText(review, { color: opts.color, verbose: opts.verbose })}\n\n`);
    const choice = await ask(`${item.packageName}@${item.version}: [a]pprove, [r]eject, [s]kip, [q]uit? (s) `);
    if (choice === 'q' || choice === 'quit') break;
    if (choice === 'a' || choice === 'approve') {
      if (review.counts.high > 0) {
        const typed = await ask(`This release has high-risk findings. Type the package name (${item.packageName}) to approve anyway: `);
        if (typed !== item.packageName.toLowerCase()) {
          process.stdout.write('Skipped.\n\n');
          continue;
        }
      }
      const ok = await stageDecide('approve', item.id);
      process.stdout.write(ok ? `Approved ${item.packageName}@${item.version}.\n\n` : 'Approval did not complete.\n\n');
    } else if (choice === 'r' || choice === 'reject') {
      const sure = await ask(`Rejecting permanently deletes this staged version. Reject ${item.packageName}@${item.version}? [y/N] `);
      if (sure === 'y' || sure === 'yes') {
        const ok = await stageDecide('reject', item.id);
        process.stdout.write(ok ? `Rejected ${item.packageName}@${item.version}.\n\n` : 'Rejection did not complete.\n\n');
      }
    } else {
      process.stdout.write('Skipped.\n\n');
    }
  }
  if (!interactive) output(reviews, opts.format, opts.color, opts.verbose);
  return reviews;
}

async function cmdList(opts: Options): Promise<void> {
  await ensureStageSupport();
  const items = await stageList();
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  if (items.length === 0) {
    process.stdout.write('No staged releases are waiting for approval.\n');
    return;
  }
  for (const item of items) {
    process.stdout.write(
      `${item.packageName}@${item.version}${item.tag ? ` (${item.tag})` : ''}  ${stagedBy(item) ?? ''}  ${item.createdAt ?? ''}\n  ${item.id}\n`,
    );
  }
}

async function cmdCi(opts: Options, passthrough: string[]): Promise<Review> {
  if (opts.stagePublish) await ensureStageSupport();
  const dir = scratchDir();
  try {
    const after = await packDirectory(process.cwd());
    const tarballPath = join(dir.path, 'package.tgz');
    writeFileSync(tarballPath, after);
    const { name, version, tag } = manifestOf(after);
    // Before a version bump (e.g. on a pull request) the local version is already
    // on npm: compare with it, so the report shows only the unreleased changes.
    const published = await viewVersion(`${name}@${version}`);
    if (published?.version === version && opts.stagePublish) {
      throw new UsageError(`${name}@${version} is already on npm. Bump the version before staging a release.`);
    }
    const base =
      published?.version === version
        ? { spec: `${name}@${version}`, ...(published.publisher ? { publisher: published.publisher } : {}) }
        : await baselineFor(name, version, opts.tagGiven ? opts.tag : (tag ?? opts.tag));
    const before = base ? await packSpec(base.spec) : null;
    const review = reviewTarballs(before, after, { ignore: opts.ignore, ...(base?.publisher ? { previousPublisher: base.publisher } : {}) });
    const failing = failsAt(review, opts.failOn);

    let approveCommand: string | undefined;
    let stageId: string | null = null;
    if (opts.stagePublish && !failing) {
      ({ stageId } = await stagePublish(tarballPath, passthrough));
      approveCommand = stageId
        ? `# review and approve interactively\nnpx stagecheck\n\n# or approve this release directly\nnpm stage approve ${stageId}`
        : 'npx stagecheck';
    }

    output([review], opts.format, opts.color, opts.verbose);
    if (opts.stagePublish && !failing) {
      // Keep stdout machine-readable for --format json/markdown.
      const stream = opts.format === 'text' ? process.stdout : process.stderr;
      stream.write(`\nStaged ${name}@${version}${stageId ? ` with id ${stageId}` : ''}. It goes live once a maintainer approves it:\n  npx stagecheck\n`);
    }
    const summaryFile = opts.summary ?? process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) appendFileSync(summaryFile, `${renderMarkdown(review, approveCommand ? { approveCommand } : {})}\n`);
    // Step outputs for GitHub Actions.
    if (process.env.GITHUB_OUTPUT) {
      const out = { ...review.counts, name, version, 'stage-id': stageId ?? '' };
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
    }
    if (failing && opts.stagePublish) {
      process.stderr.write(`stagecheck: not staging ${name}@${version} because the review found ${opts.failOn}-severity issues.\n`);
    }
    return review;
  } finally {
    dir.dispose();
  }
}

interface Options {
  format: 'text' | 'markdown' | 'json';
  failOn: Severity | 'none';
  tag: string;
  tagGiven: boolean;
  verbose: boolean;
  color: boolean;
  stagePublish: boolean;
  summary?: string;
  ignore: string[];
}

async function main(argv: string[]): Promise<number> {
  const dashdash = argv.indexOf('--');
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      'fail-on': { type: 'string' },
      tag: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      'stage-publish': { type: 'boolean', default: false },
      summary: { type: 'string' },
      ignore: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...rest] = positionals;
  const format = values.format ?? 'text';
  if (!['text', 'markdown', 'json'].includes(format)) throw new UsageError(`--format must be text, markdown or json`);
  const failOn = values['fail-on'] ?? (command === 'ci' ? 'high' : 'none');
  if (failOn !== 'none' && !SEVERITIES.includes(failOn as Severity)) throw new UsageError('--fail-on must be high, medium, low or none');
  if (values['stage-publish'] && command !== 'ci') throw new UsageError('--stage-publish only works with stagecheck ci');
  if (values.tag !== undefined && !/^[\w.+-]+$/.test(values.tag)) throw new UsageError('--tag must be a dist-tag name');
  try {
    ignoreMatcher(values.ignore ?? []);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const opts: Options = {
    format: format as Options['format'],
    failOn: failOn as Options['failOn'],
    tag: values.tag ?? 'latest',
    tagGiven: values.tag !== undefined,
    verbose: values.verbose,
    color: useColor(!values['no-color']),
    stagePublish: values['stage-publish'],
    ignore: values.ignore ?? [],
    ...(values.summary ? { summary: resolve(values.summary) } : {}),
  };

  switch (command) {
    case undefined: {
      const reviews = await cmdInteractive(opts);
      return reviews.some((r) => failsAt(r, opts.failOn)) ? 1 : 0;
    }
    case 'list':
      await cmdList(opts);
      return 0;
    case 'review': {
      const review = await cmdReview(rest, opts);
      output([review], opts.format, opts.color, opts.verbose);
      return failsAt(review, opts.failOn) ? 1 : 0;
    }
    case 'ci': {
      const review = await cmdCi(opts, passthrough);
      return failsAt(review, opts.failOn) ? 1 : 0;
    }
    default:
      throw new UsageError(`unknown command "${command}". Run stagecheck --help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`stagecheck: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write('Run stagecheck --help for usage.\n');
    else if (!(error instanceof NpmError) && error instanceof Error && error.stack && process.env.DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 2;
  },
);
