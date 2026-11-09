# 在 CI 中审阅变更

把每一次图谱变化的说明放到审阅者本来就会看的地方：PR 上有一份摘要，点一下就能打开交互式报告；需要的话，还可以让检查失败。

## GitHub Actions

kgdiff 的 action 把 PR 里的图谱文件和它们在基准分支上的版本做比较：

```yaml
# .github/workflows/graph-diff.yml
name: Graph diff

on:
  pull_request:
    paths: [ontology/**]

permissions:
  contents: read
  pull-requests: write # 用于评论

jobs:
  kgdiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: iiwish/kgdiff@v0
        with:
          files: ontology/onto.ttl
```

每次运行，这个 action 会：

- 用 Git 读出每个文件在基准分支上的样子，和 PR 里的文件做比较。它只取回需要的那一个提交，所以检出可以保持浅克隆。基准分支上还没有的文件和空图比较，PR 删除的文件也一样；
- 把 Markdown 摘要追加到作业摘要（job summary）；
- 把 HTML 报告作为工件（artifact）上传：只有一份报告时，下载下来就是 `kgdiff-report.html`；有多份时，是一个名为 `kgdiff-report` 的 zip，每个文件一份报告；
- 图谱有变化时在 PR 上发一条评论，之后每次推送都在原处更新这条评论：评论里有一个隐藏标记，用来找回它。一个 PR 无论推送多少次，都只有一条 kgdiff 评论。

摘要和评论会转义所有标签，并让 GitHub 的自动链接失效，所以标签永远不会 @ 到别人、链接到 issue，也不会被渲染成 HTML。

### 输入和输出

| 输入                | 默认值                                 | 作用                                                                                                                                                                |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`             | （必填）                               | 图谱文件，每行一个。可以写 glob 模式（`ontology/*.ttl`；`**` 可以跨目录，如 `data/**/*.json`），同时匹配 PR 里和基准分支上的文件，所以被删除的文件也会参与比较。    |
| `base`              | 基准分支                               | 要比较的分支、标签或提交。在 `pull_request` 中，默认是 PR 的合并提交所基于的那个提交；在 `push` 中，是推送之前的提交。其他事件需要显式设置。                        |
| `version`           | 与 action 对应的版本                   | action 运行的 `@kgdiff/cli` 版本：`0.2.0`、`0.2` 或 `latest`，在 npm 上解析。0.8.0 起，action 会下载该版本适合运行器的原生 kgdiff；更早的版本用 `npx` 运行。        |
| `args`              |                                        | 额外的 kgdiff 选项，例如 `--match similarity --hierarchy rdfs:subClassOf --lang zh,en --ignore-attr modified`。按空白拆分，引号把多个词合成一个参数，不做任何展开。 |
| `comment`           | `true`                                 | 在 PR 上评论。需要 `pull-requests: write` 权限。                                                                                                                    |
| `fail-on-changes`   | `false`                                | 图谱有变化时让检查失败（`--exit-code`），在摘要、报告和评论都写完之后。                                                                                             |
| `name`              | `kgdiff-report`                        | 工件的名字。同一个工作流里多次运行这个 action 时，名字不同，工件和评论就各自独立。                                                                                  |
| `locale`            | `en`                                   | 摘要、评论和报告的语言：`en` 或 `zh-CN`。                                                                                                                           |
| `working-directory` | `.`                                    | 仓库所在目录，用于 `actions/checkout` 把仓库检出到子目录（`path:`）的情况；`files` 相对于它。                                                                       |
| `token`             | <code v-pre>${{ github.token }}</code> | 评论使用的令牌。                                                                                                                                                    |

`--title`、`--locale`、`--markdown`、`-o`、`--reproducible`、`--allow-empty` 和 `--exit-code` 由 action 自己设置。它的输出有：`changed`（至少一张图有变化时为 `true`）、`summary-file`（Markdown 摘要文件，方便其他步骤把它发到别处）、`artifact-url` 和 `comment-url`。

### 来自 fork 的 PR

来自 fork 的 PR 拿到的是只读令牌。这时 action 跳过评论，照常写作业摘要、上传报告，并且不会失败：审阅者在这次运行的摘要页里阅读变更列表，从运行的工件里下载报告。如果评论因为其他原因失败，比如作业没有 `pull-requests: write` 权限，或者是 Dependabot 发起的 PR，action 只给出警告并继续执行；作业摘要里有同样的内容。

### 多个图谱

可以列出多个文件，或者写 glob 模式。每个文件在摘要和评论里各占一节，也各有一份报告；和基准分支上逐字节相同的文件合并成一行列出。

```yaml
- uses: iiwish/kgdiff@v0
  with:
    files: |
      ontology/*.ttl
      data/lineage.json
    args: --lang zh,en
```

在一个工作流里多次运行这个 action（两个作业，或者一个矩阵）时，给每次运行设置不同的 `name`：它是工件的名字，而工件名在一次工作流运行中必须唯一；它也让各自的评论互不干扰。

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

同一个 PR 上同时有两次运行时，它们可能都去创建评论。用 `concurrency` 分组可以让每个 PR 同一时间只有一次运行：

```yaml
concurrency:
  group: graph-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

### 图谱有变化时让检查失败

`fail-on-changes: true` 让任何差异都使检查失败，但会先写好摘要、报告和评论。和 `base: HEAD` 比较，可以检查重新生成的文件和已提交的版本是否一致，比如要求提交到仓库的生成图谱始终是最新的：

```yaml
- run: ./build-graph.sh > graph.json
- uses: iiwish/kgdiff@v0
  with:
    files: graph.json
    base: HEAD # 已提交的版本；工作区里是重新生成的版本
    fail-on-changes: true
```

kgdiff 读不了的文件（语法错误、文件不存在）总是会让检查失败，错误信息写在摘要里。

### 版本与安全

- `iiwish/kgdiff@v0` 跟随 0.x 的各个版本。每次发版都会移动 `v0` 标签，而 action 运行的是和它一起发布的 kgdiff 版本，所以只有标签移动时，CI 的输出才会变化。要固定版本，可以用版本标签（`@v0.2.0`），或者更稳妥地用它的提交（`@<sha> # v0.2.0`），Dependabot 会帮你更新。用 `version` 可以让同一个 action 运行别的 kgdiff 版本。
- action 从不运行 PR 里的代码。它在临时目录里运行 npm 上的 kgdiff，环境变量里不带令牌：0.8.0 起是运行器对应平台包（`@kgdiff/cli-linux-x64-gnu` 等）里的原生程序，用 `npm pack` 下载，并按 npm 注册表公布的完整性校验值核对；更早的版本用 `npx` 运行 TypeScript 版 CLI。输入通过 `env` 传给脚本，从不在 shell 里展开 <code v-pre>${{ }}</code>；分支名和文件名从事件数据里读取，不经过命令行。kgdiff 的输出用 `::stop-commands::` 隔开，图谱里的任何内容都无法冒充工作流命令。
- 它的脚本需要 Node.js 22 或更高版本，GitHub 托管的运行器都满足。如果运行器上的 Node.js 太旧，它会用 `actions/setup-node` 装上 Node.js 24，这也会把它加到后续步骤的 `PATH` 里。
- 检出里没有基准提交时，action 会从 `origin` 取回这一个提交。私有仓库要用到 `actions/checkout` 默认保留的凭据；如果设置了 `persist-credentials: false`，就改用 `fetch-depth: 0` 检出。

## 其他 CI 系统

换成别的 CI，做法也一样：取出文件的旧版本，运行 kgdiff，把报告保存为工件，把 Markdown 放到审阅者会看的地方。以 GitLab CI 为例：

```yaml
graph-diff:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: [ontology/onto.ttl]
  script:
    - git fetch --depth=1 origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    # 目标分支上还没有这个文件时，base.ttl 是空文件。
    - git show "FETCH_HEAD:ontology/onto.ttl" > base.ttl || true
    - npx --yes @kgdiff/cli@0.1 base.ttl ontology/onto.ttl --allow-empty
      -o kgdiff-report.html --reproducible --markdown kgdiff.md
  artifacts:
    paths: [kgdiff-report.html, kgdiff.md]
    expose_as: kgdiff report
```

- `npx --yes @kgdiff/cli@0.1` 不经确认就运行 0.1 系列的版本；固定版本可以避免新版本在你不知情时改变 CI 的输出。也可以把 `@kgdiff/cli` 加进 devDependencies，然后运行 `npx @kgdiff/cli`。
- `--allow-empty` 把空输入当作空图，而不是报错。
- 一次运行写出两种输出：`--markdown` 写摘要，`-o` 写报告。`--title` 同时用作两者的标题。`--reproducible` 不在报告里写时间戳，输入相同，文件就完全相同。
- `--exit-code` 让任何差异都以退出码 1 结束，于是作业失败，并打印出变了什么。

## 提示

- 本地和 CI 使用相同的选项（`--match`、`--hierarchy`、`--lang`、`--ignore-attr`，在 action 里通过 `args` 传入），这样审阅者看到的就是你看到的 diff。
- 图非常大时，`--stat` 和 `--markdown` 最省资源，HTML 报告最耗资源。输入解压后的大小上限是 1 GB，可以用 `KGDIFF_MAX_INPUT=4G` 调高（在 action 的步骤上作为 `env` 设置）。
- [命令行参考](../cli.md)列出了全部选项。
