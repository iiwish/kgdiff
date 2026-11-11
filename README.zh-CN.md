<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html?lang=zh"><img src="docs/images/replay-zh.webp" alt="kgdiff 查看器逐组回放企业信用知识图谱本体两个版本之间的变化" width="880"></a>
</p>

<p align="center">
  <b>知识图谱的 git diff。</b><br>
  看清图谱的两个版本之间到底变了什么，并像审阅 Pull Request 一样逐项审阅。
</p>

<p align="center">
  <a href="https://iiwish.github.io/kgdiff/playground.html?lang=zh"><b>在浏览器里试用</b></a> ·
  <a href="https://iiwish.github.io/kgdiff/?lang=zh">官网</a> ·
  <a href="https://iiwish.github.io/kgdiff/docs/zh/">文档</a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/architecture.md">架构</a> ·
  <a href="docs/cli.md">命令行</a> ·
  <a href="docs/visual-language.md">视觉语言</a> ·
  <a href="docs/delta-format.md">增量格式</a>
</p>

---

如今，GraphRAG 流水线、Agent 记忆、本体助手、语义层都在由 AI 编写和改写知识图谱，这些改动需要有人审阅。文本 diff 只能看到三元组的增删；多数可视化工具则是重新跑一次力导布局再给节点换个颜色，整张图都会跳。**kgdiff 告诉你真正发生了什么**：一次合并、一次改名、一个类被挪到新的父类下、一条关系改为指向别处——它们都画在同一张稳定的地图上，配一个为审阅而设计的查看器。

```sh
npx @kgdiff/cli before.ttl after.ttl -o report.html --open
```

不想装任何东西？[Playground](https://iiwish.github.io/kgdiff/playground.html?lang=zh) 可以直接在浏览器里比较示例数据，或者你自己的两个文件，不会上传任何数据。

## 四个理念

|                    |                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **语义，而非语法** | 跨版本匹配节点：按 id、按替代声明，或在 id 没有意义时（比如两次 LLM 抽取）按名称与邻域相似度匹配。变化被归类为改名、换 id、类型、别名、属性、弃用、替代关系、层级迁移、合并、拆分、改指向、谓词变化。 |
| **同一张心智地图** | 两个版本共用一个确定性的、为标签留足空间的布局。没变的东西不会动；被删除的东西以空心虚线「幽灵」的形式留在原处。                                                                                      |
| **颜色即含义**     | 只有五类颜色：新增、删除、内容、结构、身份，未变的上下文为灰色。每种颜色都另有形状或线型线索，并内置色盲友好配色。                                                                                    |
| **审阅是一套流程** | 变化按依赖顺序分成变更组。可以逐个浏览、回放从旧到新的演变、标记已审阅，并导出可逆的增量补丁。                                                                                                        |

## 你会得到

- **`<kgdiff-viewer>`**：与框架无关的 Web 组件，三种对比方式——**叠加**、**滑动对比**（拖动分隔线对照前后）、**回放**（旧图按变更组逐步演变成新图），每种都可以叠加**仅看变更**（大图默认打开）；外加可搜索、可筛选的变更列表，带字符级差异的详情面板，审阅进度，深链接，键盘快捷键，深浅主题，中英文界面。
- **`kgdiff` 命令行**：彩色终端摘要，`--stat`、`--name-status`、`--json`、`--delta`，适合 PR 评论的 `--markdown`，供 CI 使用的 `--exit-code`，应用补丁的 `apply`，以及可离线打开的单文件 HTML 报告（`-o report.html`，加 `--reproducible` 时逐字节可复现）。
- **库**：零依赖的差异引擎、解析器（RDF 用 `n3`）、稳定布局引擎、与渲染器无关的视觉模型、Canvas 渲染器，以及 AntV G6 适配器。

## 快速开始

### 终端与 CI

```sh
npx @kgdiff/cli v12.json v13.json                 # 彩色摘要
npx @kgdiff/cli old.obo new.obo --stat            # 统计
npx @kgdiff/cli a.ttl b.ttl --markdown >> "$GITHUB_STEP_SUMMARY"
npx @kgdiff/cli a.ttl b.ttl --exit-code -q        # 有差异时退出码为 1
```

`npx` 需要 Node.js ≥ 22；kgdiff 本身是原生程序，支持 macOS、Linux 和 Windows，也可以从 crates.io
安装（`cargo install kgdiff`）。

<p align="center">
  <img src="docs/images/terminal-zh.webp" alt="kgdiff 的终端摘要：企业信用知识图谱本体两个版本之间的删除、合并、迁移、改名和新增，按变化类别着色" width="720">
</p>

详见 [docs/cli.md](docs/cli.md) 和 [packages/cli/README.md](packages/cli/README.md)。

### 在 PR 上使用（GitHub Actions）

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

这个 action 把每个文件和它在基准分支上的版本做比较，把摘要写进作业摘要和一条 PR 评论（之后的推送会在原处更新这条评论），并把交互式报告作为工件上传。来自 fork 的 PR 能看到作业摘要和报告。选项、多个图谱、让检查失败等用法见 [docs/zh/guide/ci.md](docs/zh/guide/ci.md)。

### 在网页中使用

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

事件：`kgdiff-ready`、`kgdiff-select`、`kgdiff-mode`、`kgdiff-review`、`kgdiff-error`、`kgdiff-replay-end`。交互细节见 [docs/interaction.md](docs/interaction.md)。

<p align="center">
  <img src="docs/images/viewer-zh.webp" alt="kgdiff 查看器：两个版本画在同一张图上，变化按类别着色，右侧是待审阅的变更列表" width="880">
</p>

### 作为库使用

```ts
import { diff, formatHunk } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';

const before = parseGraph(beforeText, { filename: 'v12.json' }).graph;
const after = parseGraph(afterText, { filename: 'v13.json' }).graph;
const result = diff(before, after);

for (const hunk of result.hunks) console.log(formatHunk(hunk, result, 'zh-CN').title);
// 删除「抽查检查」及 2 条关系
// 「法人代表」合并入「法定代表人」
// …
```

## 支持的格式

| 类别 | 格式                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDF  | Turtle、N-Triples、N-Quads、TriG、RDF/XML（`.rdf`、Protégé / ROBOT 导出的 `.owl`）、JSON-LD 1.1（内联 context，不联网获取）：按语言偏好取标签，OWL 存在约束转为边，空白节点按内容和上下文识别，语句注解折叠 |
| OBO  | OBO 1.4：同义词、`is_a`、relationship、带 `replaced_by` 的弃用、`alt_id`                                                                                                                                    |
| JSON | kgdiff 原生格式、d3 / NetworkX 节点-连线格式、Cytoscape.js、AntV G6 v5、graphology、vis-network                                                                                                             |

同一张图换一种序列化方式，比较结果仍然完全相同。映射规则见 [docs/architecture.md](docs/architecture.md#formats-mapping-conventions)。

## 包

**装哪个。** 多数人只需要一个包，按你想做的事来选：

| 你想要……                       | 安装                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| 在终端或 CI 里比较图谱文件     | `@kgdiff/cli`（`npx @kgdiff/cli a.ttl b.ttl`），或者 GitHub Action |
| 在网页里展示差异，不写渲染代码 | `@kgdiff/viewer`（`<kgdiff-viewer>` Web 组件）                     |
| 在代码里计算差异，自己画       | `@kgdiff/core`，再按需加 `formats`、`layout`、`scene` 或 `g6`      |

`@kgdiff/cli` 运行的是原生程序：npm 会随它一起装上适合本机的那一个（`@kgdiff/cli-darwin-arm64`、`@kgdiff/cli-linux-x64-gnu` 等），不需要自己安装这些平台包。

全部包：

| 包                                      | 说明                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| [`@kgdiff/core`](packages/core)         | 差异引擎：规范化 → 匹配 → 分类 → 变更组 → 可逆补丁。零依赖。           |
| [`@kgdiff/formats`](packages/formats)   | RDF / OBO / JSON 解析器。                                              |
| [`@kgdiff/layout`](packages/layout)     | 确定性、为标签留空间的并集布局；支持锚定模式和只布局变更的模式。       |
| [`@kgdiff/scene`](packages/scene)       | 把差异语义转成视觉图元：设计令牌、编码规则、回放时间线、聚焦。         |
| [`@kgdiff/renderer`](packages/renderer) | Canvas 2D 引擎：平滑镜头、细节分级、标签布局、拾取、滑动对比、小地图。 |
| [`@kgdiff/viewer`](packages/viewer)     | `<kgdiff-viewer>` Web 组件。                                           |
| [`@kgdiff/g6`](packages/g6)             | 在 AntV G6 v5 中渲染 kgdiff 场景。                                     |
| [`@kgdiff/cli`](packages/cli)           | 命令行工具。                                                           |
| [`action.yml`](action.yml)              | GitHub Action（`uses: iiwish/kgdiff@v0`）：在 PR 上展示图谱 diff。     |
| [`apps/site`](apps/site)                | 官网和在线体验页。                                                     |

## 正确性与性能

- **确定性**：相同输入得到逐字节相同的差异、布局和报告。
- **可逆**：`apply(A, diff(A, B).delta) ≅ B`，逆补丁可还原 `A`；按审阅顺序逐组应用补丁一定成功。均由 fast-check 属性测试保证。
- **测试**：各包合计约 2200 个测试，另有验收测试让每个示例数据集跑完整条流水线。
- **实测**（M 系列笔记本，`pnpm bench`）：1 万节点 / 3 万边的差异约 0.1 秒；5 万条 RDF 三元组解析约 0.1 秒；1 万节点差异的布局（只布局变更范围）约 1.1 秒；5000 节点每帧视觉计算不到 1 毫秒；独立版查看器 gzip 后约 116 kB。

## 示例数据

[`examples/datasets`](examples/datasets) 有 6 组真实感的前后版本，并附带 kgdiff 应当报告的精确变化：企业信用知识图谱本体（中、英文各一份）、一次 OBO 疾病本体发布、两次 id 随机的 LLM 抽取、dbt 风格的数据血缘、类 schema.org 的 Turtle 词表。`scripts/gen-synthetic.ts` 可生成大规模合成数据。

## 开发

```sh
pnpm install                    # Node.js ≥ 22，pnpm 11
pnpm check                      # lint + 类型检查 + 测试
pnpm bench                      # 性能预算
pnpm dev:site                   # 官网和在线体验页
pnpm dev:docs                   # 文档站（docs/）
pnpm build:viewer-assets        # kgdiff 的 HTML 报告内嵌的查看器
cargo run -p kgdiff -- examples/datasets/enterprise-kg/before.json \
  examples/datasets/enterprise-kg/after.json
```

建议先读 [docs/architecture.md](docs/architecture.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 路线图

1.0：`@kgdiff/compute` 取代浏览器里的 TypeScript 计算模块（[RFC 0002](docs/rfcs/0002-rust-compute-core.md) 第 5 阶段）· [RFC 0003](docs/rfcs/0003-embedding-hosts.md)（嵌入宿主）的其余部分 · 导出 KGCL 和 RDF Patch · 三方合并与冲突可视化 · 面向超大图的 Web Worker 流水线和 WebGL 渲染器 · Cytoscape.js 与 Sigma.js 适配器 · Python 绑定。

## 许可证

[MIT](LICENSE)。示例数据采用 CC0。
