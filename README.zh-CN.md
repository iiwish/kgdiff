<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html?lang=zh"><img src="docs/images/replay-zh.webp" alt="kgdiff 查看器逐组回放企业信用知识图谱本体两个版本之间的变化" width="880"></a>
</p>

<h1 align="center">kgdiff</h1>

<p align="center">
  <b>知识图谱的 git diff。</b><br>
  看清图谱的两个版本之间到底变了什么，并像审阅 Pull Request 一样逐项审阅。
</p>

<p align="center">
  <a href="https://github.com/iiwish/kgdiff/actions/workflows/ci.yml"><img src="https://github.com/iiwish/kgdiff/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@kgdiff/cli"><img src="https://img.shields.io/npm/v/@kgdiff/cli?label=npm&color=3B5BDB" alt="npm"></a>
  <a href="https://crates.io/crates/kgdiff"><img src="https://img.shields.io/crates/v/kgdiff?color=3B5BDB" alt="crates.io"></a>
  <a href="https://iiwish.github.io/kgdiff/docs/zh/"><img src="https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%C2%B7%20English-3B5BDB" alt="文档"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3B5BDB" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html?lang=zh"><b>在浏览器里试用</b></a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/zh/getting-started">快速开始</a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/zh/">文档</a> ·
  <a href="https://iiwish.github.io/kgdiff/?lang=zh">官网</a> ·
  <a href="README.md">English</a>
</p>

---

如今，GraphRAG 流水线、Agent 记忆、本体助手、语义层都在由 AI 编写和改写知识图谱，这些改动需要有人审阅。文本 diff 只能看到三元组的增删；多数可视化工具则是重新跑一次力导布局再给节点换个颜色，整张图都会跳。**kgdiff 告诉你真正发生了什么**：一次合并、一次改名、一个类被挪到新的父类下、一条关系改为指向别处——它们都画在同一张稳定的地图上，配一个为审阅而设计的查看器。

```sh
npx @kgdiff/cli before.ttl after.ttl -o report.html --open
```

不想装任何东西？[Playground](https://iiwish.github.io/kgdiff/playground.html?lang=zh) 可以直接在浏览器里比较示例数据，或者你自己的两个文件，不会上传任何数据。

## 为什么不用文本 diff？

拿[企业信用知识图谱本体](examples/datasets/enterprise-kg)的两个版本来看。`git` 能告诉你的是：

```console
$ git diff --no-index --stat before.json after.json
 before.json => after.json | 62 ++++++++++++++++++++++++++---------------------
 1 file changed, 34 insertions(+), 28 deletions(-)
```

kgdiff 告诉你的是，每一行对应审阅者要做的一个判断（为了排版，这里去掉了节点 id 一列）：

```console
$ kgdiff before.json after.json --name-status --locale zh-CN | cut -f1,3
D	删除「抽查检查」及 2 条关系
G	「法人代表」合并入「法定代表人」
V	「股权出质」移至「股权投资」下
E	「十大股东」的「持股」改为指向「上市公司」（原为「企业」）
E	新增关系「实际控制」—穿透依据→「投资」
M	修改「企业」
M	弃用「中外合资企业」
M	修改「商标」的属性
M	修改「失信被执行人」的别名
R	「高管任职」改名为「董监高任职」
M	修改「限制高消费」的类型
A	新增「受益所有人」及 3 条关系
```

`D` 删除，`G` 合并，`V` 迁移，`E` 关系变化，`M` 修改，`R` 改名，`A` 新增。同一张图换成 N-Triples 写、换一种语句顺序或者换个前缀名，比较结果仍然完全相同：kgdiff 比较的是图，不是文件。

## 四个理念

- **语义，而非语法。** 跨版本匹配节点：按 id、按 OBO `replaced_by` 这类替代声明，或在 id 没有意义时（比如两次 LLM 抽取）按名称与邻域相似度匹配；每一处变化都有名字：改名、换 id、类型、别名、属性、弃用、层级迁移、合并、拆分、改指向、谓词变化。
- **同一张心智地图。** 两个版本共用一个确定性的、为标签留足空间的布局。没变的东西不会动；被删除的东西以空心「幽灵」的形式留在原处。
- **颜色即含义。** 只有五类颜色：新增、删除、内容、结构、身份，未变的上下文为灰色。每种颜色都另有形状或线型线索，并内置色盲友好配色。
- **审阅是一套流程。** 变化按依赖顺序分成变更组。可以逐个浏览、回放从旧到新的演变、标记已审阅，并导出可逆的增量补丁。

<p align="center">
  <img src="docs/images/viewer-zh.webp" alt="kgdiff 查看器：两个版本画在同一张图上，变化按类别着色，右侧是待审阅的变更列表" width="880">
</p>

## 快速开始

### 在终端里

```sh
npx @kgdiff/cli v12.json v13.json                 # 彩色摘要
npx @kgdiff/cli old.obo new.obo --stat            # 统计
npx @kgdiff/cli a.ttl b.ttl -o report.html        # 单文件交互式报告，可离线打开
npx @kgdiff/cli a.ttl b.ttl --exit-code -q        # 有差异时退出码为 1
```

kgdiff 是原生程序，支持 macOS、Linux（glibc 和 musl）和 Windows。`npx` 需要 Node.js ≥ 22，会装上适合本机的二进制。没有 Node.js 时，可以从 PyPI 安装同一个二进制 `pykgdiff`（只带命令行），或者用 `cargo install kgdiff` 编译：

```sh
pipx install pykgdiff                             # 或者 uv tool install pykgdiff、pip install pykgdiff
uvx --from pykgdiff kgdiff a.ttl b.ttl            # 不安装，直接运行
```

<p align="center">
  <img src="docs/images/terminal-zh.webp" alt="kgdiff 的终端摘要：企业信用知识图谱本体两个版本之间的删除、合并、迁移、改名和新增，按变化类别着色" width="720">
</p>

全部选项见[命令行参考](docs/zh/cli.md)；配合 `git diff` 和 `git difftool` 使用见[配合 git 使用](docs/zh/guide/git.md)。

### 在 PR 上

```yaml
jobs:
  kgdiff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # 用于评论
    steps:
      - uses: actions/checkout@v7
      - uses: iiwish/kgdiff@v0
        with:
          files: ontology/*.ttl
          locale: zh-CN
```

这个 action 把每个文件和它在基准分支上的版本做比较，把摘要写进作业摘要和一条 PR 评论（之后的推送会在原处更新这条评论），并把交互式报告作为工件上传。来自 fork 的 PR 能看到作业摘要和报告。选项、多个图谱、让检查失败等用法见[在 CI 中审阅变更](docs/zh/guide/ci.md)。

### 在网页里

```html
<kgdiff-viewer theme="auto" locale="zh-CN" style="height: 640px"></kgdiff-viewer>
<script type="module">
  import '@kgdiff/viewer';
  const viewer = document.querySelector('kgdiff-viewer');
  await viewer.load({
    before: { text: await (await fetch('v1.ttl')).text(), filename: 'v1.ttl' },
    after: { text: await (await fetch('v2.ttl')).text(), filename: 'v2.ttl' },
  });
</script>
```

三种对比方式——**叠加**、**滑动对比**（拖动分隔线对照前后）、**回放**（旧图按变更组逐步演变成新图），每种都可以叠加**仅看变更**；外加可搜索的变更列表、带字符级差异的详情面板、审阅进度、深链接、键盘快捷键、深浅主题、中英文界面。可以直接用整个查看器，也可以用它的元素[自己拼布局](docs/zh/guide/viewer.md)。交互和事件见[查看器：交互与 API](docs/zh/interaction.md)。

### 在代码里

```ts
import { diff, formatHunk, parseGraph } from '@kgdiff/core';

const before = (await parseGraph(beforeText, { filename: 'v12.json' })).graph;
const after = (await parseGraph(afterText, { filename: 'v13.json' })).graph;
const result = await diff(before, after);

for (const hunk of result.hunks) console.log(formatHunk(hunk, result, 'zh-CN').title);
// 删除「抽查检查」及 2 条关系
// 「法人代表」合并入「法定代表人」
// …
```

只需 `npm install @kgdiff/core`。引擎用 Rust 编写，在 JavaScript 里以 WebAssembly 运行（`@kgdiff/compute`，第一次调用时加载），输出与命令行逐字节相同。详见[在代码中使用引擎](docs/zh/guide/library.md) · [在 Rust 应用中嵌入](docs/zh/guide/embedding.md) · [迁移到 0.11](docs/zh/guide/migrating-to-0.11.md)。

## 能识别哪些变化

| 类别     | 符号    | 变化                                  |
| -------- | ------- | ------------------------------------- |
| **新增** | `+`     | 新节点及其关系                        |
| **删除** | `−`     | 被删除的节点及其关系                  |
| **内容** | `~`     | 改名、类型、别名、属性、弃用          |
| **结构** | `⇄`     | 层级迁移、关系改指向、谓词变化        |
| **身份** | `⊕` `⑂` | 合并、拆分、换 id：来自替代声明或推断 |

kgdiff 拿不准的节点配对不会被匹配，而是作为「可能的匹配」列在摘要和查看器里，由你来确认。判断依据见 [kgdiff 如何区分各种变化](docs/zh/guide/matching.md)，精确规则见 [Algorithms](docs/algorithms.md)（英文）。

## 适用场景

| 你在处理……                        | 从这里开始                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 本体发布（OBO、OWL）              | [本体：OBO 与 OWL](docs/zh/guide/ontologies.md)                                                                       |
| LLM 和 GraphRAG 抽取，id 没有意义 | [没有稳定 id 的图](docs/zh/guide/llm-graphs.md)                                                                       |
| 放在 git 里的图谱文件             | [配合 git 使用](docs/zh/guide/git.md) · [在 CI 中审阅变更](docs/zh/guide/ci.md)                                       |
| 要给用户展示图谱变化的产品        | [嵌入查看器](docs/zh/guide/viewer.md) · [在 Rust 应用中嵌入](docs/zh/guide/embedding.md)                              |
| 用 AntV G6 画的图                 | [用 G6 浏览单张图](docs/zh/guide/g6.md) · [`@kgdiff/g6`](packages/g6)                                                 |
| 版本之间的补丁                    | [增量：应用与反向](docs/zh/guide/deltas.md) · [增量格式](docs/zh/delta-format.md) · [版本约定](docs/zh/versioning.md) |

## 支持的格式

| 类别 | 格式                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDF  | Turtle、N-Triples、N-Quads、TriG、RDF/XML（`.rdf`、Protégé / ROBOT 导出的 `.owl`）、JSON-LD 1.1（内联 context，不联网获取）：按语言偏好取标签，OWL 存在约束转为边，空白节点按内容和上下文识别，语句注解折叠 |
| OBO  | OBO 1.4：同义词、`is_a`、relationship、带 `replaced_by` 的弃用、`alt_id`                                                                                                                                    |
| JSON | kgdiff 原生格式、d3 / NetworkX 节点-连线格式、Cytoscape.js、AntV G6 v5、graphology、vis-network                                                                                                             |

格式根据文件名和内容自动识别。映射规则见[格式](docs/zh/formats.md)。缺你要的格式？[提一个格式需求](https://github.com/iiwish/kgdiff/issues/new?template=format_request.yml)。

## 与其他工具对比

|                                        | 文本 diff      | 本体 diff 工具（ROBOT diff 等） | kgdiff                       |
| -------------------------------------- | -------------- | ------------------------------- | ---------------------------- |
| 识别合并、拆分、改名、迁移             | 只有行的增删   | 公理或实体级，部分能识别改名    | 能，并分成变更组             |
| 忽略序列化差异（顺序、前缀、空白节点） | 不能           | 公理级                          | 能，基于规范化的图模型       |
| 适用于任意图，不只是 OWL               | 任意文本       | OWL                             | RDF、OBO 和 JSON 图格式      |
| 两个版本画在同一张稳定的图上           | —              | 文本、表格或树                  | 能，还能回放                 |
| 审阅流程                               | 在 PR 里逐行看 | 报告                            | 变更组、已审阅状态、键盘操作 |
| 可逆补丁                               | `git apply -R` | 视工具而定                      | 能，带哈希校验               |

kgdiff 不对 OWL 公理做推理：需要公理级审阅时，可以和 `robot diff` 一起用（见[本体指南的局限一节](docs/zh/guide/ontologies.md)）。

## 正确性与性能

- **确定性。** 相同输入得到逐字节相同的差异、增量、布局和报告（`--reproducible` 去掉报告里的时间戳）。CI 会检查布局在 Linux、macOS、Windows 和 WebAssembly 上的哈希完全一致。
- **可逆。** `apply(A, diff(A, B).delta) ≅ B`，逆补丁可还原 `A`；按审阅顺序逐组应用补丁一定成功。由 fast-check 属性测试保证。
- **只有一个引擎。** 命令行、库、查看器和 Playground 跑的是同一份 Rust 代码。由 Rust crate 生成的[一致性语料](conformance/README.md)在每次提交时由 TypeScript 读取路径检查，每个[示例数据集](examples/datasets)都要跑完整条流水线，并与它应当产生的变化逐一比对。
- **实测**（Apple M5，kgdiff 0.11；除标注「原生」的以外，都是 Node 24 下的 WebAssembly）：

  | 项目                             | 耗时                       |
  | -------------------------------- | -------------------------- |
  | diff，1 万节点 / 3 万边          | 约 0.14 秒（原生 30 毫秒） |
  | diff，10 万节点 / 30 万边，原生  | 约 0.47 秒                 |
  | 解析 5 万条 Turtle 三元组        | 约 0.11 秒                 |
  | 1 万节点差异的布局（只布局变更） | 约 0.5 秒                  |
  | 5000 节点每帧视觉计算            | 不到 1 毫秒                |

  独立版查看器 gzip 后约 119 kB，不含 WebAssembly；引擎（gzip 后约 390 kB）只在需要计算时才加载。全部数字以及仍未达到的目标见 [RFC 0002 第 5 阶段结果](docs/rfcs/0002-rust-compute-core.md#phase-5-results)（英文）。

## 包

**多数人只需要一个**，按你想做的事来选：

| 你想要……                       | 安装                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| 在终端或 CI 里比较图谱文件     | `@kgdiff/cli`（`npx @kgdiff/cli a.ttl b.ttl`），或者 GitHub Action      |
| ……用 Python 工具，不装 Node.js | PyPI 上的 `pykgdiff`（`pipx install pykgdiff`）：同一个 `kgdiff`        |
| 在网页里展示差异，不写渲染代码 | `@kgdiff/viewer`（`<kgdiff-viewer>` Web 组件）                          |
| 在代码里计算差异，自己画       | `@kgdiff/core` 和 `@kgdiff/compute`，再按需加 `layout`、`scene` 或 `g6` |
| 在 Rust 应用里嵌入引擎         | crate `kgdiff-core`、`kgdiff-layout`、`kgdiff-report`                   |

<details>
<summary><b>全部 npm 包和 crate</b></summary>

| npm                                     |                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------- |
| [`@kgdiff/cli`](packages/cli)           | 命令行工具：安装并运行适合本机平台的原生 `kgdiff`。                    |
| [`@kgdiff/viewer`](packages/viewer)     | `<kgdiff-viewer>` Web 组件，以及组成它的各个元素。                     |
| [`@kgdiff/core`](packages/core)         | 差异模型：解析、`diff`、JSON 传输、可逆补丁、变更组标题。              |
| [`@kgdiff/compute`](packages/compute)   | 编译为 WebAssembly 的 kgdiff Rust 引擎：差异、解析、布局。             |
| [`@kgdiff/layout`](packages/layout)     | 确定性、为标签留空间的并集布局；支持锚定模式和只布局变更的模式。       |
| [`@kgdiff/scene`](packages/scene)       | 把差异语义转成视觉图元：设计令牌、编码规则、回放时间线、聚焦。         |
| [`@kgdiff/renderer`](packages/renderer) | Canvas 2D 引擎：平滑镜头、细节分级、标签布局、拾取、滑动对比、小地图。 |
| [`@kgdiff/g6`](packages/g6)             | 在 AntV G6 v5 中渲染 kgdiff 场景。                                     |
| [`@kgdiff/formats`](packages/formats)   | 0.11 起弃用：已移到 `@kgdiff/core`（函数相同）。                       |

| crates.io                                 |                                                      |
| ----------------------------------------- | ---------------------------------------------------- |
| [`kgdiff`](crates/kgdiff)                 | 命令行，也可以作为库使用（I/O 通过 trait 注入）。    |
| [`kgdiff-core`](crates/kgdiff-core)       | 匹配、变化分类、变更组和可逆增量。                   |
| [`kgdiff-formats`](crates/kgdiff-formats) | 解析器：RDF、OBO 和各种 JSON 图格式。                |
| [`kgdiff-layout`](crates/kgdiff-layout)   | 单张图和差异的稳定布局，以及布局文档。               |
| [`kgdiff-report`](crates/kgdiff-report)   | 终端摘要、`--stat`、Markdown、报告载荷和 HTML 报告。 |

另外还有 GitHub Action（[`action.yml`](action.yml)，`uses: iiwish/kgdiff@v0`）和带 Playground 的官网（[`apps/site`](apps/site)）。`@kgdiff/cli` 会自动带上本机平台的包（`@kgdiff/cli-darwin-arm64`、`@kgdiff/cli-linux-x64-gnu` 等），不需要自己安装。同一次发布的所有 npm 包和 crate 版本号相同。

</details>

## 文档

|          |                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **入门** | [kgdiff 是什么？](docs/zh/index.md) · [快速开始](docs/zh/getting-started.md) · [常见问题](docs/zh/faq.md)                                                                                                                                                                             |
| **指南** | [CI](docs/zh/guide/ci.md) · [git](docs/zh/guide/git.md) · [本体](docs/zh/guide/ontologies.md) · [LLM 图谱](docs/zh/guide/llm-graphs.md) · [匹配](docs/zh/guide/matching.md) · [查看器](docs/zh/guide/viewer.md) · [库](docs/zh/guide/library.md) · [Rust](docs/zh/guide/embedding.md) |
| **参考** | [命令行](docs/zh/cli.md) · [格式](docs/zh/formats.md) · [查看器 API](docs/zh/interaction.md) · [查看器元素](docs/zh/viewer-elements.md) · [增量格式](docs/zh/delta-format.md)                                                                                                         |
| **原理** | [Architecture](docs/architecture.md) · [Algorithms](docs/algorithms.md) · [Visual language](docs/visual-language.md) · [RFCs](docs/rfcs)（英文）                                                                                                                                      |

中英文文档都发布在 [iiwish.github.io/kgdiff/docs/zh](https://iiwish.github.io/kgdiff/docs/zh/)。

## 路线图

**0.11**（2026-11-12）把所有计算都搬到了 Rust 引擎上：命令行原生运行，其他一切通过 `@kgdiff/compute`。**0.12** 为 1.0 整理公开 API：Rust API 给 1.0 之后的新增留出位置，让它们都不需要升主版本，JavaScript API 只保留有文档的部分（[迁移到 0.12](docs/zh/guide/migrating-to-0.12.md)），它是最后一个带破坏性变更的版本。**1.0** 就是 0.12 在只发补丁版本的两周之后原样发布，并把实验性接口转为稳定（[RFC 0002](docs/rfcs/0002-rust-compute-core.md#kgdiff-10)、[版本约定](docs/zh/versioning.md)）。

1.0 之后，只做增量添加：读取 GraphML 和 GEXF · 导出 KGCL 和 RDF Patch · MCP 服务，让 Agent 审阅自己对图谱的修改 · Python 与 Jupyter · 面向嵌入宿主的单图朴素视图和分组背景（[RFC 0003](docs/rfcs/0003-embedding-hosts.md)）· Cytoscape.js 与 Sigma.js 适配器 · 三方合并与冲突可视化 · 面向超大图的 Web Worker 流水线和 WebGL 渲染器。进展和可以认领的事项见[路线图 issue](https://github.com/iiwish/kgdiff/issues/21)。

## 参与贡献

欢迎提交 bug、格式需求、指南和代码。可以从标了 [good first issue](https://github.com/iiwish/kgdiff/issues?q=is%3Aopen+label%3A%22good+first+issue%22) 和 [help wanted](https://github.com/iiwish/kgdiff/issues?q=is%3Aopen+label%3A%22help+wanted%22) 的 issue 开始；问题和想法请发到 [Discussions](https://github.com/iiwish/kgdiff/discussions)。

```sh
pnpm install                               # Node.js ≥ 22，pnpm 11
pnpm --filter @kgdiff/compute build:wasm   # 引擎的 WebAssembly，首次以及改动 crates/ 之后构建
pnpm check                                 # lint + 类型检查 + 测试
cargo test --workspace                     # Rust crate 的测试
pnpm dev:site                              # 官网和 Playground
cargo run -p kgdiff -- examples/datasets/enterprise-kg/before.json \
  examples/datasets/enterprise-kg/after.json
```

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)（构建 WebAssembly 需要几样工具），再读 [Architecture](docs/architecture.md)。请遵守[行为准则](.github/CODE_OF_CONDUCT.md)；安全漏洞请按 [SECURITY.md](.github/SECURITY.md) 的说明私下报告。

## 引用

如果在研究中用到 kgdiff，欢迎引用：GitHub 的 _Cite this repository_ 按钮读取的是 [CITATION.cff](CITATION.cff)。

## 许可证

[MIT](LICENSE)。示例数据采用 CC0。
