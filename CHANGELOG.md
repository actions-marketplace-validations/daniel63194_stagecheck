# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.2

### Fixed

- `npx stagecheck` could fail with "Permission denied" when npm reinstalled it over an existing link, for example in the npx cache. The CLI file now ships as executable.

## 0.1.1

### Fixed

- A crafted tarball with a negative entry size made stagecheck loop forever. Such tarballs are now rejected. Found by the new fuzz tests.
- A new dependency whose name matches a built-in object property, such as `constructor`, was not reported as added.
- When npm fails, stagecheck now shows npm's error message instead of the path to npm's log file, and says that a release whose approval failed is still staged.

### Added

- `stagecheck ci <file.tgz>` reviews a tarball you packed yourself, and with `--stage-publish` stages exactly that file.
- Property-based fuzz tests (fast-check) for the tar reader, the rules and the reports.
- GitHub releases carry the npm tarball and a signed SLSA build provenance attestation.

## 0.1.0

First release.

- `stagecheck`: review pending staged releases one by one, then approve, reject or skip each. High-risk releases need the package name typed to approve.
- `stagecheck list`: list staged releases.
- `stagecheck review`: compare any version with the previous one, or two versions or tarballs.
- `stagecheck ci`: review the local package against npm, write a GitHub job summary and step outputs, and optionally stage the exact reviewed tarball with `npm stage publish`.
- GitHub Action (`daniel63194/stagecheck`) wrapping `stagecheck ci`.
- 28 rules covering install scripts, dependency sources, credential access, exfiltration endpoints, workflow planting, self-publishing, pipe-to-shell, obfuscation, secrets files, native binaries, publisher changes and more.
- `--ignore rule[:path]` to leave out expected findings.
- Text, Markdown and JSON output. Library API with TypeScript types. Zero dependencies.
