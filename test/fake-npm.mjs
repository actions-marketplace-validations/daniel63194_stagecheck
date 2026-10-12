#!/usr/bin/env node
// A stand-in for npm used by the CLI tests (selected with STAGECHECK_NPM).
// Behaviour is driven by the JSON file in FAKE_NPM_STATE; every call is logged.
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const state = JSON.parse(readFileSync(process.env.FAKE_NPM_STATE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(state.log, `${JSON.stringify(args)}\n`);

const out = (s) => process.stdout.write(`${s}\n`);
const notFound = (what) => {
  process.stderr.write(`npm error code E404\nnpm error 404 Not Found - ${what}\n`);
  process.exit(1);
};

function resolve(spec) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const ref = at > 0 ? spec.slice(at + 1) : 'latest';
  const pkg = state.packages?.[name];
  if (!pkg) return null;
  const version = pkg.versions[ref] ? ref : pkg.tags?.[ref];
  return version && pkg.versions[version] ? { name, version, tarball: pkg.versions[version], publisher: pkg.publishers?.[version] } : null;
}

const [cmd, sub, third] = args;

if (cmd === '--version') {
  out(state.npmVersion ?? '11.16.0');
} else if (cmd === 'pack') {
  const dest = args.includes('--pack-destination') ? args[args.indexOf('--pack-destination') + 1] : process.cwd();
  const spec = args.slice(1).find((a) => !a.startsWith('--') && a !== dest);
  if (!spec) {
    copyFileSync(state.packCwd, join(dest, 'project-local.tgz'));
  } else {
    const r = resolve(spec);
    if (!r) notFound(spec);
    copyFileSync(r.tarball, join(dest, `${r.name.replace('@', '').replace('/', '-')}-${r.version}.tgz`));
  }
} else if (cmd === 'view') {
  const spec = sub;
  if (args.includes('versions')) {
    const pkg = state.packages?.[spec];
    if (!pkg) notFound(spec);
    out(JSON.stringify(Object.keys(pkg.versions)));
  } else {
    const r = resolve(spec);
    if (!r) notFound(spec);
    out(JSON.stringify(r.publisher ? { version: r.version, _npmUser: { name: r.publisher, email: 'x@example.com' } } : { version: r.version }));
  }
} else if (cmd === 'stage' && sub === 'list') {
  out(JSON.stringify((state.staged ?? []).map(({ tarball, ...item }) => item)));
} else if (cmd === 'stage' && sub === 'download') {
  const item = (state.staged ?? []).find((s) => s.id === third);
  if (!item) notFound(third);
  copyFileSync(item.tarball, join(process.cwd(), `${item.packageName}-${item.version}-${item.id}.tgz`));
  out(`${item.packageName}-${item.version}-${item.id}.tgz`);
} else if (cmd === 'stage' && (sub === 'approve' || sub === 'reject')) {
  out(`Staged package ${third} ${sub === 'approve' ? 'approved and published successfully' : 'has been rejected'}.`);
} else if (cmd === 'stage' && sub === 'publish' && state.stagePublishError) {
  process.stderr.write(state.stagePublishError);
  process.exit(1);
} else if (cmd === 'stage' && sub === 'publish') {
  out(`+ ${state.stagePublishAs ?? 'demo@1.0.1'} (staged with id 11111111-2222-4333-8444-555555555555)`);
} else {
  process.stderr.write(`fake npm: unsupported ${JSON.stringify(args)}\n`);
  process.exit(1);
}
