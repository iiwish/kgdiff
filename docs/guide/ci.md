# Review changes in CI

Put a readable account of every graph change where reviewers already look: a summary on the pull
request, the interactive report one click away and, if you want, a failing check.

## GitHub Actions

The kgdiff action compares graph files in a pull request with their versions on the base
branch:

```yaml
# .github/workflows/graph-diff.yml
name: Graph diff

on:
  pull_request:
    paths: [ontology/**]

permissions:
  contents: read
  pull-requests: write # the comment

jobs:
  kgdiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: iiwish/kgdiff@v0
        with:
          files: ontology/onto.ttl
```

On every run, the action:

- reads each file as it is on the base branch with Git and compares it with the file in the pull
  request. It fetches the one commit it needs, so the checkout can stay shallow. A file the base
  branch does not have yet is compared with an empty graph, and so is a file the pull request
  deletes;
- appends the Markdown summary to the job summary;
- uploads the HTML report as an artifact: one report downloads as `kgdiff-report.html`, several
  as a zip `kgdiff-report` with one report per file;
- comments on the pull request once a graph has changed, and updates that comment in place on
  every later push: a hidden marker in the comment finds it again. A pull request gets one kgdiff
  comment, however often it is pushed to.

The summary and the comment escape every label and defuse GitHub's autolinking, so a label never
mentions people, links issues or renders as HTML.

### Inputs and outputs

| Input               | Default                                | What it does                                                                                                                                                                                                   |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`             | (required)                             | Graph files, one per line. A glob pattern (`ontology/*.ttl`; `**` crosses directories, as in `data/**/*.json`) matches files in the pull request and on the base branch, so deleted files are compared too.    |
| `base`              | the base branch                        | Branch, tag or commit to compare with. On `pull_request`, the default is the commit the pull request's merge commit was built on; on `push`, the commit before the push. Other events need it set.             |
| `version`           | the action's release                   | The `@kgdiff/cli` version the action runs: `0.2.0`, `0.2` or `latest`, resolved on npm. From 0.8.0 on, the action downloads the native kgdiff of that version for the runner; earlier versions run with `npx`. |
| `args`              |                                        | More kgdiff options, e.g. `--match similarity --hierarchy rdfs:subClassOf --lang zh,en --ignore-attr modified`. Split on whitespace; quotes group words; nothing is expanded.                                  |
| `comment`           | `true`                                 | Comment on the pull request. Needs `pull-requests: write`.                                                                                                                                                     |
| `fail-on-changes`   | `false`                                | Fail when a graph changed (`--exit-code`), once the summary, the report and the comment are written.                                                                                                           |
| `name`              | `kgdiff-report`                        | Name of the artifact. Runs of the action in one workflow that set different names keep separate artifacts and comments.                                                                                        |
| `locale`            | `en`                                   | Language of the summary, the comment and the report: `en` or `zh-CN`.                                                                                                                                          |
| `working-directory` | `.`                                    | The repository, when `actions/checkout` put it in a subdirectory (`path:`); `files` are relative to it.                                                                                                        |
| `token`             | <code v-pre>${{ github.token }}</code> | Token for the comment.                                                                                                                                                                                         |

The action sets `--title`, `--locale`, `--markdown`, `-o`, `--reproducible`, `--allow-empty` and
`--exit-code` itself. Its outputs: `changed` (`true` when at least one graph changed),
`summary-file` (the Markdown summary, for another step to post elsewhere), `artifact-url` and
`comment-url`.

### Pull requests from forks

A pull request from a fork runs with a read-only token. There the action skips the comment,
writes the job summary, uploads the report and passes: reviewers read the change list in the
run's summary and download the report from its artifacts. When a comment fails for another reason,
such as a job without `pull-requests: write` or a Dependabot pull request, the action warns and
goes on; the job summary has the same text.

### Several graphs

List several files, or glob patterns. Each file gets its own section in the summary and in the
comment, and its own report; files that are byte for byte the same as on the base branch share
one line.

```yaml
- uses: iiwish/kgdiff@v0
  with:
    files: |
      ontology/*.ttl
      data/lineage.json
    args: --lang zh,en
```

To run the action more than once in a workflow (two jobs, or a matrix), give each run its own
`name`: it names the artifact, which must be unique in a workflow run, and keeps the comments
apart.

```yaml
strategy:
  matrix:
    graph: [disease, anatomy]
steps:
  - uses: actions/checkout@v7
  - uses: iiwish/kgdiff@v0
    with:
      files: ontology/${{ matrix.graph }}.obo
      name: kgdiff-${{ matrix.graph }}
```

Two runs on one pull request at the same time could both create the comment. A `concurrency`
group keeps one run per pull request:

```yaml
concurrency:
  group: graph-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

### Fail the check when a graph changes

`fail-on-changes: true` turns any difference into a failed check, after the summary, the report
and the comment are in place. Comparing with `base: HEAD` checks a regenerated file against the
committed one, for example to require that a generated graph is committed up to date:

```yaml
- run: ./build-graph.sh > graph.json
- uses: iiwish/kgdiff@v0
  with:
    files: graph.json
    base: HEAD # the committed version; the working tree is the regenerated one
    fail-on-changes: true
```

A file kgdiff cannot read (a syntax error, a missing file) always fails the check; its error is in
the summary.

### Versions and security

- `iiwish/kgdiff@v0` follows the 0.x releases. Each release moves the `v0` tag, and the action
  runs the kgdiff version it was released with, so your CI output changes only when the tag
  moves. Pin a release with its tag (`@v0.2.0`) or, safer, its commit (`@<sha> # v0.2.0`), which
  Dependabot keeps up to date. `version` runs another kgdiff version with the same action.
- The action never runs code from the pull request. It runs kgdiff from npm in a temporary
  directory, without the token in its environment: the native binary of the platform package
  `@kgdiff/cli` installs on the runner (`@kgdiff/cli-linux-x64-gnu`, …), fetched with `npm pack`
  and checked against the integrity the npm registry publishes, or, for versions before 0.8.0,
  the TypeScript CLI with `npx`. Inputs reach its scripts through
  `env`, never by expanding <code v-pre>${{ }}</code> in a shell, and branch and file names are
  read from the event, not from the command line. kgdiff's output is fenced with
  `::stop-commands::`, so nothing in a graph can pass for a workflow command.
- Its scripts need Node.js 22 or later, which GitHub-hosted runners have. On a runner with an older
  Node.js, it sets up Node.js 24 with `actions/setup-node`, which also puts it on the `PATH` for
  later steps.
- When the checkout does not have the base commit, the action fetches that one commit from
  `origin`. In a private repository this uses the credentials `actions/checkout` keeps by default;
  with `persist-credentials: false`, check out with `fetch-depth: 0` instead.

## Other CI systems

Anywhere else, the recipe is the same: get the old version of the file, run kgdiff, keep the
report as an artifact and put the Markdown where reviewers look. In GitLab CI, for example:

```yaml
graph-diff:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: [ontology/onto.ttl]
  script:
    - git fetch --depth=1 origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    # An empty base.ttl when the target branch does not have the file yet.
    - git show "FETCH_HEAD:ontology/onto.ttl" > base.ttl || true
    - npx --yes @kgdiff/cli@0.1 base.ttl ontology/onto.ttl --allow-empty
      -o kgdiff-report.html --reproducible --markdown kgdiff.md
  artifacts:
    paths: [kgdiff-report.html, kgdiff.md]
    expose_as: kgdiff report
```

- `npx --yes @kgdiff/cli@0.1` runs the 0.1 release line without a prompt; pinning keeps a new
  release from changing your CI output unannounced. Alternatively, add `@kgdiff/cli` to your
  devDependencies and run `npx @kgdiff/cli`.
- `--allow-empty` reads an empty input as an empty graph instead of failing.
- One run writes both outputs: `--markdown` the summary, `-o` the report. `--title` names both.
  `--reproducible` leaves the timestamp out of the report, so identical inputs give identical
  files.
- `--exit-code` turns any difference into exit code 1, which fails the job and prints what
  changed.

## Tips

- Use the same options locally and in CI (`--match`, `--hierarchy`, `--lang`, `--ignore-attr`,
  through the action's `args`), so reviewers see the diff you saw.
- For very large graphs, `--stat` and `--markdown` are the lightest outputs and the HTML report
  the heaviest. Inputs are limited to 1 GB after decompression; `KGDIFF_MAX_INPUT=4G` raises the
  limit (on the action's step, as `env`).
- [CLI reference](../cli.md) lists every option.
