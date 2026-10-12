# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

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
