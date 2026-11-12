# Security policy

## Supported versions

kgdiff is pre-1.0: security fixes go into the latest release of the `kgdiff` and `@kgdiff/*`
packages, which always share one version. Please upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue. Report privately instead:

- through GitHub: [Report a vulnerability](https://github.com/iiwish/kgdiff/security/advisories/new)
  (the repository's Security tab), or
- by email to num2048@163.com.

Include the affected package and version, what an attacker controls (a graph file, a report, a
command-line argument…), the impact, and the smallest input that shows it. You will get an answer
within a week; once a fix is released, the advisory credits you unless you prefer otherwise.

## Scope

kgdiff reads graph files that may come from anyone and writes reports that others open, so these
are in scope, among others:

- parsers (`@kgdiff/formats`, the CLI) hanging, crashing the process or exhausting memory on a
  crafted input of reasonable size;
- script injection in HTML reports or in `<kgdiff-viewer>` through labels, ids or attributes;
- GitHub Markdown output (`--markdown`) that mentions people, links issues or injects HTML;
- terminal escape or bidi sequences reaching the terminal through the CLI's output;
- the CLI overwriting a file it was not asked to write, including its own inputs.

## Verifying releases

Releases are published from GitHub Actions with npm trusted publishing, and every version after
the first carries an npm provenance attestation: `npm audit signatures` verifies it in your project.
