# Contributing to stagecheck

Thanks for helping. The most valuable contributions are **false-positive reports** (stagecheck flagged something harmless) and **missed detections** (a real attack, or a realistic one, that it did not flag). Both directly improve the rules.

## Development

You need Node.js 22.12+ for the dev tooling. The published package runs on Node.js 20.19+.

```sh
git clone https://github.com/daniel63194/stagecheck
cd stagecheck
npm ci
npm test          # builds, then runs the tests
npm run typecheck
```

Try your build against real packages:

```sh
node dist/cli.js review esbuild@0.24.0 esbuild@0.25.0
node dist/cli.js review some-package@1.2.3 --verbose
```

The project has **no runtime dependencies**, and that is deliberate: a supply-chain security tool should not add to anyone's supply chain. Please don't add any. Dev dependencies are fine when they earn their place.

## How the code is organised

| File | What it does |
| --- | --- |
| `src/tar.ts` | Reads `.tgz` files in memory (ustar, pax, GNU long names) with size limits. |
| `src/diff.ts` | Diffs file maps and `package.json` manifests. |
| `src/rules.ts` | All detection rules. Start here to add or tune a rule. |
| `src/review.ts` | Runs the diff and the rules, applies `--ignore`, counts findings. |
| `src/report.ts` | Text, Markdown and JSON output. Escapes untrusted text. |
| `src/npm.ts` | The only module that runs npm (`pack`, `view`, `stage …`). |
| `src/cli.ts` | Command-line interface. |

The CLI tests use `test/fake-npm.mjs` in place of npm (via `STAGECHECK_NPM`), so they never touch the registry.

## Adding or changing a rule

1. **Base it on something real.** Link the incident, advisory or write-up in the pull request. Rules exist to catch what attackers actually do.
2. **Write the tests first** in `test/rules.test.ts`:
   - a release that **should** trigger the rule, and
   - an ordinary release that looks similar but **must not** trigger it. Most rule bugs are false positives, so this test matters as much as the first.
3. **Pick the severity honestly.**
   - `high`: something an ordinary release almost never does, which would make you stop and investigate. The CI default is `--fail-on high`, so every high finding blocks someone's release.
   - `medium`: worth a look, often legitimate.
   - `low`: context.
4. **Check the noise** against a few popular packages, including ones that legitimately do similar things, with `node dist/cli.js review <pkg>@<old> <pkg>@<new>`. Mention what you tried in the pull request.
5. Update the rules table in `README.md` and add a `CHANGELOG.md` entry.

Content rules see only the lines a release adds, and `src/rules.ts` filters candidates against the whole previous version (see the comment near the end of `runRules`). New line patterns get that filtering for free.

## False positives

If stagecheck flags a harmless release, please open a [false positive report](https://github.com/daniel63194/stagecheck/issues/new?template=false-positive.yml) with the package and versions. We would rather tighten a rule than teach people to ignore the tool.

## Pull requests

- Keep each pull request focused on one change.
- `npm test` and `npm run typecheck` must pass.
- Write commit messages that explain *why*.
- New features and bug fixes come with tests. A pull request that changes behaviour without a test will not be merged.

## Releasing (maintainers)

Releases are staged, never published directly:

1. `npm version <patch|minor|major>` and `git push --follow-tags`.
2. The release workflow tests the package, reviews it with the stagecheck it just built, and stages it with `npm stage publish` (trusted publishing, with provenance).
3. On your machine, run `npx stagecheck`, read the review, and approve with 2FA.

The very first release cannot use trusted publishing, because npm can only trust a workflow for a package that exists. Stage it from your machine instead:

```sh
npm ci && npm test
npm login
node dist/cli.js ci --stage-publish --fail-on none -- --access public
node dist/cli.js            # review and approve
```

`--fail-on none` is needed there because a first release is compared with nothing, so `dist/rules.js`, which contains the patterns stagecheck looks for, matches its own rules. Then add `release.yml` as a trusted publisher on npmjs.com, and push the `v0.1.0` tag: the release workflow sees that the version is already on npm, skips staging and creates the GitHub release.
