# Releasing

kgdiff publishes eight packages from this repository: the CLI `@kgdiff/cli` (command `kgdiff`)
and `@kgdiff/core`, `formats`, `layout`, `scene`, `renderer`, `viewer` and `g6`. They share one
version number (a Changesets "fixed" group, `.changeset/config.json`): the CLI embeds the viewer
bundle and the report payload ties core, layout and scene together, so "kgdiff 0.3.1" names one
consistent set. The CLI is the native `kgdiff` (`crates/kgdiff`): `@kgdiff/cli` is its launcher,
and seven platform packages that the release assembles hold the binaries (below), at the same
version, as do the crates.

## Day to day

1. A pull request that changes a published package adds a changeset: `pnpm changeset`, pick the
   bump, write one or two sentences for the changelog. Before 1.0 (Cargo's convention for `0.x`):
   additions and fixes are `patch`, breaking changes are `minor`, and `major` is not used. CI's
   cargo-semver-checks and the API reports stop a break under a `patch` changeset (below). From
   1.0 on, fixes are `patch`, additions `minor` and breaking changes `major`. Docs-, test- and tooling-only changes need no changeset.
2. On every push to `main`, [`release.yml`](../.github/workflows/release.yml) collects the
   pending changesets into a "chore: release packages" pull request that bumps the versions and
   updates each `CHANGELOG.md` (`pnpm version-packages`: `changeset version`, then Biome formats
   the changelogs, since a changeset with several paragraphs indents its blank lines, and
   `scripts/sync-citation.ts` sets the version in `CITATION.cff`; a test fails if they differ).
3. Merging that pull request publishes. The workflow first builds the native `kgdiff` for every
   target, packages the crates and assembles and tests the platform packages of `@kgdiff/cli`;
   then it runs `pnpm release` (`pnpm check`, `pnpm build`, `pnpm check:packages`, the platform
   packages, `changeset publish`), publishes every package whose version is not on npm yet and
   pushes the `<package>@<version>` tags. It then tags the GitHub
   Action (below) and creates one GitHub release, `v<version>`, for the whole group: its notes
   (`scripts/release-notes.ts`) merge the packages' changelog sections, list each change once
   with the packages it changed, and leave out the "Updated dependencies" entries. Releases up to
   0.4.0 were created per package (`@kgdiff/cli@0.4.0`, …).
4. A push with no changeset and nothing to publish (the version is on npm and tagged
   `v<version>`, as after every finished release) skips "Version or publish": `plan` says
   "Nothing to release". Without a changeset, `changesets/action` always runs `pnpm release`,
   whose `pnpm check` needs the WebAssembly modules of `@kgdiff/compute`, and those are built only
   for a release (`compute-wasm`); before this, every push to `main` after 0.11.0 failed there.

The version pull request is opened with the workflow's `GITHUB_TOKEN`, and GitHub holds the CI
run of a pull request created that way until a maintainer approves it (the run shows "action
required"). `main` requires the `CI passed` check (see [Repository settings](#repository-settings)),
so approve the run on the pull request before merging it, close and reopen the pull request, or
give `changesets/action` a GitHub App token through `github-token`.

## The API reports

The TypeScript counterpart of the `semver` job's cargo-semver-checks is a report per public entry
point, committed under `packages/<name>/api/` (`index.api.md` for `.`, `elements-root.api.md` for
`./elements/root`, …). `scripts/api-report.ts` writes them with API Extractor from `dist/*.d.ts`:
every `exports` entry with a `types` condition, plus the modules the viewer's standalone bundles
are built from. `@kgdiff/cli` (a command) has none.
The `check` job runs `pnpm api:check` after `pnpm build`, once (Linux, Node 24), and fails when
a report differs from the build. Unlike cargo-semver-checks it compares with the commit, not with
the last release, so a report that changed in a pull request still differs from the last
release's when the version pull request is reviewed: `git diff v<last version> -- 'packages/*/api'`
lists every change to the public types since then.

A report that changed means the public API changed. An added line is an addition; a removed or
changed line breaks code that uses it, unless the item is marked `// @experimental`. Before 1.0
that is a `minor` release (0.12 → 0.13), as any breaking change, and a `patch` changeset with a
removed or changed line in a report is wrong: the line must be an addition, or the changeset
`minor`. From 1.0 on it is a major release of every package ([Versioning](./versioning.md)), so a
version pull request with a pending `minor` or `patch` changeset and a removed or changed line in
a report is not merged as it is. 1.0 itself
removes the `@experimental` marks of the renderer's layers, the scene's node shapes and the
report's `shapes`: the `// @experimental` lines go from the reports with them, and from then on
those items are covered like the rest.

API Extractor's messages stay in the reports: `ae-forgotten-export` names a type that a public
signature uses but no entry point exports, and `ae-internal-missing-underscore` an export marked
`@internal`.

## The GitHub Action

[`action.yml`](../action.yml), at the root of the repository, is the kgdiff GitHub Action
(`uses: iiwish/kgdiff@v0`; [guide](./guide/ci.md)), with its scripts in [`action/`](../action).
It runs the `@kgdiff/cli` version that `packages/cli/package.json` has in the same commit, so a
tag names one action and one CLI version:

- Once `release.yml` has published `@kgdiff/cli`, it tags the release commit `v<version>`
  (`v0.2.0`, never moved) and moves `v<major>` (`v0`) to it, through the GitHub API with the job's
  token. A prerelease gets only its own tag. Users pin `@v0`, `@v0.2.0`, or the commit with a
  `# v0.2.0` comment, which Dependabot updates from these tags.
- [`action.yml`](../.github/workflows/action.yml) (the workflow) runs the action on the example
  datasets whenever the action or the datasets change: job summary, artifact, a pull request
  comment updated in place (on pull requests from this repository), a run with a read-only token
  like a fork's, and Windows and macOS. Unit tests in `action/test` run with `pnpm test`.
- The action arrived after the last release, so its first tags are set by hand, on the first
  `main` commit that has it: `v<version>` with the version in that commit's
  `packages/cli/package.json` (already on npm), and `v0`. From the next release on, `release.yml`
  takes over.

  ```sh
  git tag v0.1.0 <commit>   # the CLI version in that commit
  git tag v0 <commit>
  git push origin v0.1.0 v0
  ```

### GitHub Marketplace

The repository meets GitHub Marketplace's requirements: it is public, has one action metadata
file at its root, and the action's `name`, `kgdiff`, is not a GitHub user or organization. Listing
is done by hand in the web UI, by the repository owner with 2FA on, once the GitHub Marketplace
Developer Agreement is accepted: under Releases, edit the newest `v<version>` release (or open
`action.yml` and follow the banner), tick "Publish this Action to the GitHub Marketplace", pick
the categories (for example Code review and Utilities) and update the release. GitHub's
documentation does not say whether a later release that `release.yml` creates through the API is
listed on its own: after a release, check the listing, and edit the release the same way if it
still shows the previous version. To unlist the action, untick the box on every listed release.

## Publishing: npm trusted publishing

`release.yml` holds no npm token. pnpm exchanges the job's GitHub OIDC token for a short-lived
publish token and, because the repository and the packages are public, attaches a provenance
attestation (built from this repository, by this workflow, at this commit) to every version. The job needs only `id-token: write`, plus
`contents: write` and `pull-requests: write` for the tags, releases and version pull request; it
restores no caches, and it runs in the `npm` environment, which can be limited to `main`.

npm checks that `repository.url` in each `package.json` matches the GitHub repository exactly.

## @kgdiff/cli and its platform packages

`@kgdiff/cli` holds only a launcher (`packages/cli/bin/kgdiff.js`, `lib/launcher.js`) that runs
the native `kgdiff` of the machine, from one of seven optional dependencies npm picks by `os`,
`cpu` and `libc`: `@kgdiff/cli-darwin-arm64`, `-darwin-x64`, `-linux-arm64-gnu`,
`-linux-x64-gnu`, `-linux-arm64-musl`, `-linux-x64-musl` and `-win32-x64`
([RFC 0002](rfcs/0002-rust-compute-core.md), §6). The platform packages are not in the
repository: [`scripts/npm-platforms.ts`](../scripts/npm-platforms.ts) assembles each from the
dist archive of its target (checked against its `.sha256`), with a `package.json` of the
release's version, a README and the LICENSE. In `release.yml`, `npm-platforms` packs them,
`npm-smoke` and `npm-smoke-musl` run `kgdiff` through the launcher on Linux (x64 and Arm64,
glibc and musl), macOS and Windows, and `pnpm release` publishes them before `@kgdiff/cli`, whose
`package.json` gets the optional dependencies, at that exact version, only then: the committed one
has none, so the workspace never asks npm for a version it does not have yet.

Trusted publishing needs a package to exist, so each platform package gets a first version by hand,
from the archives of a release run (Actions → Release → the run → Artifacts, or `gh run
download`), once, shortly before the first release that publishes them:

```sh
gh run download <run id> -R iiwish/kgdiff -p 'native-*' -D dist   # the version in packages/cli
pnpm tsx scripts/npm-platforms.ts assemble dist target/npm
npm login --registry=https://registry.npmjs.org/
for tarball in target/npm/kgdiff-cli-*-*.tgz; do npm publish "$tarball" --access public; done
```

Then add the trusted publisher of each (owner `iiwish`, repository `kgdiff`, workflow
`release.yml`, environment `npm`), as for the other packages, and let the release take over.
`node scripts/npm-smoke.mjs target/npm` runs the same smoke test locally.

## Adding a package

A package that is new on npm cannot be published by `release.yml`: trusted publishing needs the
package to exist (`E404 … PUT https://registry.npmjs.org/@kgdiff%2f<name>`). `changeset publish`
publishes the packages in dependency order and stops at the first failure, after the ones before
it are out. 0.11.0 met this with `@kgdiff/compute`: `@kgdiff/core`, which depends on it, was
already `latest` and could not be installed until `@kgdiff/compute` followed.

So publish the new package's first version **before** the version pull request that releases it
is merged:

1. Make the package public (`"private"` gone, `publishConfig`, `repository` with its
   `directory`), add it to the `fixed` group of `.changeset/config.json` (a test checks that
   every public package is in it at one version) and let `pnpm check:packages` cover it.
2. Pack the version the release will publish. Take what the build needs from a run of the release
   workflow on the commit (Actions → Release → Run workflow builds everything and publishes
   nothing), not from a local build, so that the tarball holds what the release would have
   published; `pnpm pack` writes the workspace's versions into its dependencies. For
   `@kgdiff/compute`:

   ```sh
   gh run download <run id> -R iiwish/kgdiff -n compute-wasm -D packages/compute/
   pnpm install --frozen-lockfile && pnpm build
   (cd packages/compute && pnpm pack --pack-destination ../../target/npm-manual)
   tar -tzf target/npm-manual/kgdiff-compute-<version>.tgz   # the three .wasm, no test/
   ```

3. Publish it by hand, at the official registry whatever the machine installs from:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm publish target/npm-manual/kgdiff-<name>-<version>.tgz --access public \
     --registry=https://registry.npmjs.org/
   ```

   This version has no provenance attestation; later ones do.
4. Add its trusted publisher on npmjs.com (owner `iiwish`, repository `kgdiff`, workflow
   `release.yml`, environment `npm`, direct publishing allowed). npm expires a configuration
   that has not completed a publish within two days ([One-time setup](#one-time-setup)), and the
   release that follows skips the version published by hand, so the configuration is first used
   by the next release: make that one within two days, or add the publisher again before it.
5. Merge the version pull request. The release finds the new package's version on npm and
   publishes the others.

A new crate is the same on crates.io ([Native binaries and crates](#native-binaries-and-crates)):
`crates-publish` skips a crate that does not exist there, with a notice, instead of failing.

## When a release stops half-way

A release run builds and checks everything before it publishes anything, so most failures leave
nothing behind: fix the cause in a pull request, and the push to `main` releases again (the
version is not on npm, so `plan` says "Releasing").

When the run fails **after** publishing some packages, nothing is taken back: a version cannot
be published twice or removed. Find out what is out before doing anything else:

```sh
# npm, at the official registry (a mirror lags; so does the registry itself for a few minutes
# after a publish, when one query may say 200 and the next 404)
for p in core layout scene renderer viewer g6 cli compute; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://registry.npmjs.org/@kgdiff/$p/<version>"
done
curl -s https://crates.io/api/v1/crates/kgdiff-core | jq -r .crate.max_version
curl -s https://pypi.org/pypi/pykgdiff/<version>/json | jq -r '.urls[].filename'
gh release view v<version> -R iiwish/kgdiff
```

Then:

- **Remove the cause** (a missing first version of a package: [Adding a package](#adding-a-package);
  a broken step: a pull request).
- **Run the release again.** Either re-run the failed jobs of the run (Actions → the run →
  Re-run failed jobs), or push the fix to `main`. Every step skips what exists: the platform
  packages and `changeset publish` skip versions on npm, the tag and the GitHub release are
  created once, `crates-publish` skips versions on crates.io, `pypi-publish` the wheels PyPI has.
- **The run finishes a release that an earlier run began.** `plan` treats a push as a release
  also when `@kgdiff/cli`'s version is on npm but the tag `v<version>` does not exist, and
  "Version or publish" then takes the committed version, once every public package is on npm at
  it, to create the tag, move `v<major>`, write the GitHub release and let the crates publish.
  Before 0.11.0 those steps asked whether _this run_ had published `@kgdiff/cli`, so a re-run
  that published only the remaining packages ended green without a tag, a release or the crates.
  `v<version>` then points at the commit of the run that finished the release, which may be
  later than the one that published the packages (0.11.0: the `<package>@0.11.0` tags are on the
  release commit, `v0.11.0` on the fix of the workflow).
- **While a dependency is missing**, a package that is already `latest` cannot be installed. If
  the cause takes long to remove, point `latest` back and forward again afterwards (the re-run
  does not move it: the version is already published):

  ```sh
  npm dist-tag add @kgdiff/<name>@<previous version> latest --registry=https://registry.npmjs.org/
  ```

If a published version itself is wrong, the remedy is a patch release, not a second attempt at
the same version.

## One-time setup

The repository is `iiwish/kgdiff` (package metadata, `release.yml`, `CITATION.cff`,
`.github/SECURITY.md`, the issue and pull request templates); security reports and conduct issues go to
num2048@163.com.

1. **GitHub.** Create the repository. Under Settings → Actions → General, allow GitHub Actions to
   create and approve pull requests. Under Settings → Environments, create `npm` with deployment
   branches limited to `main` (add required reviewers if releases should wait for a click).
   Under Settings → Code security, enable private vulnerability reporting (see `.github/SECURITY.md`).
2. **npm.** Create the `kgdiff` organization, which owns the `@kgdiff` scope, and turn on 2FA.
3. **First publish, by hand.** Trusted publishing can only be configured for a package that
   already exists, so the first version is published from a maintainer's machine (it has no
   provenance attestation; later versions do). Every package publishes to
   `https://registry.npmjs.org/` (`publishConfig.registry`), whatever registry the machine
   installs from, so log in there too: a mirror such as npmmirror cannot log you in.

   ```sh
   npm login --registry=https://registry.npmjs.org/
   pnpm install
   pnpm release            # check, build, check:packages, changeset publish (asks for the 2FA code)
   git push --follow-tags
   ```

4. **Trusted publishers.** For each of the packages on npmjs.com (nine since 0.11, with
   `@kgdiff/compute`), open Settings → Trusted
   publishing and add GitHub Actions with the owner `iiwish`, repository `kgdiff`, workflow
   `release.yml` and environment `npm`, allowing direct publishing (not only staged publishing).
   npm expires a configuration that has not completed a publish within two days, so do this
   shortly before merging the first version pull request.
5. **Turn on releases from CI.** Under Settings → Secrets and variables → Actions → Variables,
   set `RELEASE_ENABLED` to `true`. Until then the release workflow skips its job, so pushes to
   `main` before the first publish do not try to publish.
6. **Lock it down.** Once a release from CI has gone through, set each package to require 2FA and
   disallow tokens, and revoke publish tokens that are no longer needed.

## Native binaries and crates

The Rust `kgdiff` ([RFC 0002](rfcs/0002-rust-compute-core.md)) ships on npm (the platform
packages above) and on its own channels: binaries for macOS, Linux (gnu and musl) and Windows
on the GitHub release, with SHA-256 checksums, build provenance and shell / PowerShell
installers; a Homebrew formula in
[`iiwish/homebrew-tap`](https://github.com/iiwish/homebrew-tap) (`brew install iiwish/tap/kgdiff`);
and the crates `kgdiff-core`, `kgdiff-formats`, `kgdiff-layout`, `kgdiff-report` and `kgdiff` on
crates.io (`cargo install kgdiff`).

[`dist`](https://opensource.axo.dev/cargo-dist/) builds the binaries (`dist-workspace.toml`, the
`dist` profile of `Cargo.toml`). Its jobs are part of [`release.yml`](../.github/workflows/release.yml),
which stays the Changesets workflow (dist does not regenerate it): before a release publishes,
`native-build` builds and smoke-tests every target, `native-global` makes the checksums,
installers and formula, `crates-dry-run` packages and verifies every crate
(`cargo publish --workspace --dry-run`), and the npm jobs above assemble and test the platform
packages; a failure in any of them stops the release before anything is published. A pull
request that changes the workflow, `dist-workspace.toml` or the launcher runs the same jobs, and
so does Actions → Release → Run workflow; they never publish. The viewer bundles are built once (`pnpm build:viewer-assets`, job `native-viewer`) and
embedded by every build, so that all binaries carry the same viewer.

Publishing stays off until these are done:

1. **crates.io, each crate's first version by hand.** crates.io cannot create a crate through
   trusted publishing, so the first version of each crate is published from a maintainer's
   machine with a token: `kgdiff-core` at 0.7.0, the other four when their phase ships. Until a
   crate exists, `crates-publish` skips it with a notice and publishes the ones that do (a version
   already there is skipped too).

   ```sh
   pnpm install && pnpm build:viewer-assets
   git status --porcelain   # nothing: the viewer bundles are git-ignored
   cargo publish -p kgdiff-core --locked --allow-dirty   # or --workspace, for all five
   ```

   `--allow-dirty` because cargo counts the git-ignored viewer bundles, which `kgdiff-report`
   packages, as uncommitted changes.

2. **crates.io trusted publishers.** For each crate on crates.io, open Settings → Trusted
   Publishing and add GitHub with the owner `iiwish`, repository `kgdiff`, workflow
   `release.yml` and environment `crates-io`. Under Settings → Environments here, create
   `crates-io` with deployment branches limited to `main`. Then set the repository variable
   `CRATES_RELEASE_ENABLED` to `true`: the `crates-publish` job publishes with a short-lived
   token from the job's OIDC token, and no crates.io token is stored.
3. **Homebrew tap and binaries.** Create a fine-grained personal access token with read and write
   access to the contents of `iiwish/homebrew-tap` only. Under Settings → Environments, create
   `native` with deployment branches limited to `main` and store the token there as the secret
   `HOMEBREW_TAP_TOKEN`. Then set the repository variable `NATIVE_RELEASE_ENABLED` to `true`: the
   `native-publish` job attests the archives, uploads them with the installers and checksums to
   the `v<version>` GitHub release, and commits `Formula/kgdiff.rb` to the tap.

Releases before these steps still build and check everything; the artifacts stay with the
workflow run.

## PyPI: pykgdiff

The Python distribution [`pykgdiff`](https://pypi.org/project/pykgdiff/) (`kgdiff` is taken on
PyPI, [RFC 0002](rfcs/0002-rust-compute-core.md), D-6) is, for now, the command line only:
`pipx install pykgdiff`, `uvx --from pykgdiff kgdiff …`. Each wheel holds one target's `kgdiff`
binary as `pykgdiff-<version>.data/scripts/kgdiff`, which pip and uv install on the `PATH`, and
nothing else: no Python module (`import pykgdiff` and `python -m pykgdiff` are kept for the
Python API after 1.0, D-7). Its metadata is [`python/pyproject.toml`](../python/pyproject.toml),
whose version `scripts/sync-versions.ts` sets to the workspace's (PEP 440 spelling for
prereleases: `1.0.0-rc.1` → `1.0.0rc1`); `tests/release.test.ts` fails when it differs.

[`scripts/pypi-wheels.py`](../scripts/pypi-wheels.py) (Python ≥ 3.11, standard library) writes the
wheels from dist's archives, as `npm-platforms.ts` writes the platform packages: each archive
checked against its `.sha256`, the dist manifests against the version, so the wheels hold the
very binaries npm and the GitHub release do, with the viewer bundles `native-viewer` built once.
The platform tag comes from the binary: the minimum macOS of its Mach-O header
(`macosx_11_0_arm64`, `macosx_10_12_x86_64`), the newest glibc symbol version it needs for
manylinux (`manylinux_2_34_*` while dist builds on Ubuntu 22.04: Linux with glibc ≥ 2.34, as for
`@kgdiff/cli-linux-*-gnu`), `musllinux_1_2_*` for the static musl builds, `win_amd64`; it fails on
a binary of the wrong architecture or one that links a library a manylinux wheel may not need.
The wheels are byte-identical for identical archives. There is no sdist: building from source
needs Rust and the viewer bundles, and `cargo install kgdiff` already is that build.

In `release.yml`, `pypi-wheels` assembles them, and `pypi-smoke` / `pypi-smoke-musl` install them
with pip into a fresh virtual environment from the wheels alone (pip has to pick the machine's by
its tag) on Linux (x64 and Arm64, glibc, and Alpine), macOS and Windows and run `kgdiff`
(`scripts/pypi-smoke.py`, which also checks that `import pykgdiff` fails). "Version or publish"
waits for them like for the npm smoke tests, and pull requests that change the workflow,
`python/` or the scripts run them. After npm, `pypi-publish` uploads the wheels with PyPI trusted
publishing (OIDC, `pypa/gh-action-pypi-publish`, with attestations), no token stored; it skips a
version whose wheels PyPI has, and a rerun after a partial upload adds only the missing ones.
Locally, on the archive of one target:

```sh
dist build --tag=v<version> --artifacts=local --target=aarch64-apple-darwin --output-format=json \
  > target/distrib/aarch64-apple-darwin-dist-manifest.json   # after pnpm build:viewer-assets
uv run --no-project --python 3.12 python scripts/pypi-wheels.py target/distrib --target aarch64-apple-darwin
python3 scripts/pypi-smoke.py target/pypi
```

Publishing stays off until these are done, once, before the first release that should upload
(0.12.1):

1. **A pending trusted publisher on PyPI.** PyPI can create a project from its first upload
   through CI. Logged in at pypi.org, open Your account → Publishing → Add a new pending
   publisher → GitHub, and enter the PyPI project name `pykgdiff`, owner `iiwish`, repository
   `kgdiff`, workflow `release.yml` and environment `pypi`. A pending publisher does not reserve
   the name: until the first upload, anyone can still register `pykgdiff`, so do this shortly
   before the release. Once the project exists, the publisher becomes its ordinary trusted
   publisher (Manage → Publishing).
2. **The `pypi` environment** (it exists): deployment branches limited to `main`.
3. **Turn it on.** Set the repository variable `PYPI_RELEASE_ENABLED` to `true`. The next release
   uploads the wheels; a release that ran before can be finished by re-running its failed or
   skipped `pypi-publish` job, which takes the wheels of that run.
4. **Lock it down**, after the first upload: on pypi.org, turn on 2FA for the account if it is
   not, and check that the project has no API tokens.

## Repository settings

- **Ruleset `main`** (Settings → Rules → Rulesets) on the default branch: no deletion, no force
  push, linear history, changes through a pull request (no approval required, squash or rebase),
  and the `CI passed` check from GitHub Actions. That job of [`ci.yml`](../.github/workflows/ci.yml)
  passes only when every job of the matrix passed, so the matrix can change without touching the
  ruleset; the path-filtered Action and Pages workflows are not required. Repository admins can
  bypass the ruleset only when merging a pull request, for example a version pull request whose
  CI run is still held.
- **Pull requests**: squash and rebase merges only, head branches deleted after the merge, and an
  "Update branch" button on pull requests that are behind `main`.
- **Actions** (Settings → Actions → General): actions must be pinned to a full commit SHA, which
  every workflow and `action.yml` do (Dependabot keeps the pins current); the default token is
  read-only, and GitHub Actions may create pull requests (the version pull request).
- **Code security**: Dependabot alerts and security updates, CodeQL default setup (Actions and
  JavaScript/TypeScript), secret scanning with push protection, and private vulnerability
  reporting.

## Website

The landing page, the playground and the documentation build together into static files
(`pnpm build:site` → `apps/site/dist`) and are deployed to GitHub Pages only:
[`pages.yml`](../.github/workflows/pages.yml) builds the WebAssembly modules and the site and
deploys them on every push to `main` that touches the site, the packages or the docs. Under
Settings → Pages, set the source to GitHub Actions; the base path (`/<repo>/`, or `/` with a
custom domain) and `KGDIFF_SITE_URL`, which canonical and Open Graph tags point at, come from
there.

## What ships

`@kgdiff/cli` publishes its launcher (`bin`, `lib`), `README.md`, `package.json` and `LICENSE`;
each platform package its binary, `README.md`, `package.json` and `LICENSE`; each wheel of
`pykgdiff` its binary and, in `.dist-info`, `METADATA` (with `python/README.md`), `WHEEL`,
`RECORD` and `licenses/LICENSE`. Every other package
publishes `dist` (JavaScript, declarations and their source maps), `src` (the
TypeScript the maps point to), `README.md`, `package.json` and the root `LICENSE`, which pnpm adds
to every package. Shipping `src` keeps both `.js.map` and `.d.ts.map` resolvable: stack traces,
debuggers and "Go to Source Definition" land in the TypeScript source. The alternative,
`inlineSources`, embeds the same text in every `.js.map` and makes the maps self-contained for
tools that copy them away from the package, but it cannot fix the declaration maps, which would
then point at files that are not there; the price of shipping `src` is about the same size.

`pnpm check:packages` (after `pnpm build`) packs every package as `pnpm publish` would and checks
the tarballs: `package.json`, `README.md` and `LICENSE` present, every source map and every map
source resolvable, [publint](https://publint.dev) clean in strict mode, and
[Are the Types Wrong?](https://arethetypeswrong.github.io) clean for ESM-only packages (the
viewer's `./standalone` scripts have no types and are excluded). CI runs it on every push.
