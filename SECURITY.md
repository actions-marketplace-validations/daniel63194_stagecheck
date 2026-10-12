# Security policy

stagecheck is used to decide whether a release is safe to publish, so a bug that hides a finding can be a security bug.

## Reporting a vulnerability

Please **do not open a public issue** for vulnerabilities in stagecheck itself. Report them privately through [GitHub Security Advisories](https://github.com/daniel63194/stagecheck/security/advisories/new).

You can expect an acknowledgement within 3 working days and a plan within 10. Fixes are released as soon as they are ready, with credit to you unless you prefer otherwise.

## In scope

- A crafted tarball that makes stagecheck read the wrong files, skip files, write outside its temporary folder, or exhaust memory or CPU.
- A way for a package to suppress, hide or rewrite findings in the report, for example through terminal escape sequences or Markdown injection in the job summary.
- Command injection through package names, versions, dist-tags or Action inputs.
- A staged tarball that differs from the one stagecheck reviewed in `stagecheck ci --stage-publish`.

## Not a vulnerability

stagecheck uses heuristics. Code that avoids the rules, such as a payload assembled from string fragments, is a **missed detection**, not a vulnerability. Please report it as a [public issue](https://github.com/daniel63194/stagecheck/issues/new?template=missed-detection.yml) so the rules can improve, unless it describes an attack that is still active. In that case, report it to npm as well (`npm report` or <https://www.npmjs.com/support>).

## Supported versions

Only the latest minor release receives fixes.
