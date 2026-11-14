# 在代码中使用引擎

命令行工具和查看器都由下面这些包构建而成，你也可以直接使用它们：

| 包                 | 作用                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `@kgdiff/core`     | diff 模型和解析：解析、规范化、匹配、分类、分组、可反向的增量。                |
| `@kgdiff/layout`   | 确定性、考虑标签的布局，两个版本共用。                                         |
| `@kgdiff/scene`    | 把 diff 转成视觉元素：设计令牌、编码、回放时间线。                             |
| `@kgdiff/renderer` | Canvas 2D 渲染器：相机、细节层级、标签、拾取、小地图。                         |
| `@kgdiff/viewer`   | [`<kgdiff-viewer>` Web 组件](./viewer.md)。                                    |
| `@kgdiff/g6`       | 在 AntV G6 v5 中绘制 kgdiff 场景。                                             |
| `@kgdiff/compute`  | 编译成 WebAssembly 的 Rust 引擎：[与命令行逐字节相同](#浏览器里的-rust-引擎)。 |
| `@kgdiff/cli`      | 命令行工具 `kgdiff`：运行原生程序，不导出 JavaScript 接口。                    |

它们都只提供 ESM，可在 Node.js 22 及以上版本和主流现代浏览器中运行，不做任何 I/O：传入文本和对象，得到对象。从 0.11 起，计算类函数（`diff`、`matchNodes`、`textSimilarity`、`parseGraph`、`detectFormat`、`layoutDiff`、`extendLayout`）在 `@kgdiff/compute` 上运行，是异步的；读取和应用类函数（`normalize`、`hashGraph`、`diffFromJSON`、`applyDelta`、`formatHunk`、`layoutFromJSON` 等）仍是同步的。从 0.10 升级见[迁移到 0.11](./migrating-to-0.11.md)。`@kgdiff/formats` 从 0.12.1 起不再发布：从 0.11.1 起它的解析函数都在 `@kgdiff/core` 里，迁移只需改导入路径。

规则是：模型包（`@kgdiff/core`、`@kgdiff/layout`）提供异步入口，第一次调用时加载引擎；需要同步 API、自己指定 `.wasm` 文件位置或底层 JSON 接口时，用 [`@kgdiff/compute`](#浏览器里的-rust-引擎)。

本页讲的是 TypeScript 包。引擎本身用 Rust 写成，Rust 应用可以直接使用它的 crate：[在 Rust 应用中嵌入 kgdiff](./embedding.md) 从一张图讲到带着你自己布局的报告，再讲到浏览器一侧。

## 比较两张图

```sh
npm install @kgdiff/core
```

```ts
import { readFile } from 'node:fs/promises';
import { diff, formatHunk, parseGraph } from '@kgdiff/core';

const read = async (file: string) => parseGraph(await readFile(file, 'utf8'), { filename: file });
const before = await read('before.obo');
const after = await read('after.obo');

const result = await diff(before.graph, after.graph, { match: { strategy: 'id' } });

console.log(result.stats.nodes); // { added: 5, removed: 0, modified: 23, unchanged: 156 }
for (const hunk of result.hunks) {
  console.log(formatHunk(hunk, result, 'zh-CN').title);
}
// 「juvenile diabetes」和「insulin-dependent diabetes mellitus」合并入「type 1 diabetes mellitus」
// 「heart attack」合并入「myocardial infarction」
// …
```

- `parseGraph(text, { filename })` 判断格式，返回 `graph`，以及读到的 `format` 和 `warnings`（可恢复的异常情况，例如合并了命名图、忽略了某些字段）。传入 `format` 可以跳过格式判断。
- `diff(before, after, options)` 接受解析得到的图，也接受 [kgdiff JSON](../formats.md#kgdiff-json) 形式的普通 `{ nodes, edges }` 对象。
- `formatHunk(hunk, result, locale)` 像命令行那样描述一个变更组，给出 `title` 和 `subtitle`，语言可选 `en`（默认）或 `zh-CN`。

## 选项

```ts
await diff(before.graph, after.graph, {
  match: { strategy: 'auto', threshold: 0.82 }, // 'id' | 'auto' | 'similarity'
  hierarchyPredicates: ['is_a'], // 替换 DEFAULT_HIERARCHY_PREDICATES
  ignoreAttrs: ['creation_date'],
  detectMerges: true,
  detectSplits: true,
  edgeIdentity: 'structure', // 或 'id'
});
```

它们分别对应命令行的 `--match`、`--threshold`、`--hierarchy`、`--ignore-attr`、`--no-merges`、`--no-splits` 和 `--edge-identity`。

## 结果

| 字段                     | 内容                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `stats`                  | 节点和关系的新增、删除、修改、未变数量；按变更组类型和节点类型的统计；`identical`                     |
| `hunks`                  | 按审阅顺序排列的变更组，每组有一个 `kind`：`add`、`remove`、`modify`、`merge`、`split` 或 `relations` |
| `nodes`、`edges`         | 两个版本的并集：每个元素都带有状态和它的变化                                                          |
| `matches`、`suggestions` | 通过替代声明或相似度找到的节点对，以及差一点配上的候选                                                |
| `delta`                  | 从变化前到变化后的可反向补丁                                                                          |
| `before`、`after`        | 规范化后的两张图                                                                                      |

每个变更组都有一个 `id`，由它的类型和锚点节点组成，例如 `modify:Q42`。要按变更组保存数据（比如审阅进度），请先读 [Hunk ids](../../algorithms.md#hunk-ids)（英文）：那里写明了 id 在什么情况下不变、什么情况下会变。

## 应用、反向与校验增量

```ts
import { applyDelta, hashGraph, invertDelta, normalize } from '@kgdiff/core';

const patched = applyDelta(result.before, result.delta);
hashGraph(patched) === hashGraph(result.after); // true

const restored = applyDelta(patched, invertDelta(result.delta));
hashGraph(restored) === hashGraph(result.before); // true
```

`applyDelta` 作用于规范化后的图：`result.before`，或者重新解析后再经过 `normalize()` 的图。它会先检查输入的内容哈希，如果这张图不是增量的基准，就抛出 code 为 `delta-base-mismatch` 的 `KgdiffError`：

```ts
const delta = JSON.parse(await readFile('patch.json', 'utf8'));
const graph = normalize((await read('before.obo')).graph);
const updated = applyDelta(graph, delta);
```

传入 `{ strict: false, onSkip }` 时，它会应用所有前置条件成立的操作，并把其余操作报告给 `onSkip`。[增量：应用与反向](./deltas.md)介绍了命令行里的同样操作。

## 保存与读取

- `diffToJSON(result)` 和 `diffFromJSON(json)`：完整 diff 的 JSON 形式，和命令行 `--json` 的输出一致。`diffFromJSON` 读入时会检查文档是否自洽（状态、hunk、边的端点、delta 对应的两张图、各项计数），遇到矛盾就报出第一处。
- `packDiffJSON(json)` 和 `unpackDiffJSON(packed)`：把同一份 diff 里未变的元素打包成表（`kgdiff.diff.packed`），HTML 报告里嵌的就是这种格式；一份以未变元素为主的大 diff 会缩小到约三分之一（自带标签或属性的边不打包），解包后逐字节还原。
- `graphToJSON(graph)`：kgdiff JSON 格式的图，`parseGraph` 可以无损读回。
- `result.delta` 本身就是普通 JSON，格式见[增量格式](../delta-format.md)。

这三种 JSON 都写明了自己的 `format`（`kgdiff.diff`、`kgdiff.graph`、`kgdiff.delta`）和 `version`，并且在 `@kgdiff/core/schema/` 里各有一份 JSON Schema（见[格式](../formats.md#格式标记与-json-schema)）。读取方遇到不支持的版本，会抛出 `KgdiffError('unsupported-version')`。

## 布局与绘制

这些查看器都会替你做好。如果要构建自己的界面：

- `@kgdiff/layout` 的 `layoutDiff(result)` 为两张图的并集确定位置，结果是确定性的。
- `@kgdiff/scene` 的 `buildScene(result, layout)` 按 [kgdiff 视觉语言](../../visual-language.md)（英文）把 diff 转成视觉元素。
- `@kgdiff/renderer` 把场景画在 canvas 上；`@kgdiff/g6` 把它画进 AntV G6 图里。

各包的 README 展示了每一步：[layout](../../../packages/layout/README.md)、[scene](../../../packages/scene/README.md)、[renderer](../../../packages/renderer/README.md) 和 [g6](../../../packages/g6/README.md)。

## 浏览器里的 Rust 引擎

`@kgdiff/compute` 是编译成 WebAssembly 的 kgdiff Rust 引擎，在任何 JavaScript 引擎里算出的结果都与 kgdiff 命令行逐字节相同。它分成三个模块，各自只在用到时加载：`compute.wasm`（diff 与匹配，gzip 后约 390 KiB）、`formats.wasm`（解析器）和 `layout.wasm`（diff 的布局，小到可以内联进页面）。

```ts
import { init, diffSync, layoutDiffSync } from '@kgdiff/compute';

await init(); // 编译模块，只需一次；只要部分模块时用 init({ modules: ['compute'] })
const result = diffSync(before, after); // DiffResult，与 @kgdiff/core 的 diff() 相同
const layout = layoutDiffSync(result); // LayoutResult，与 layoutDiff() 相同
```

`*Sync` 函数要求对应模块已经加载；不带这个后缀的 `diff`、`parseGraph`、`layoutDiff` 等函数返回 Promise，并自己加载所需的模块。`json.diff`、`json.parseGraph`、`json.layoutDiff` 等以 JSON 文本进出。只为已有 diff 布局的页面引入 `@kgdiff/compute/layout`，它不会加载另外两个模块。全部函数见[包的 README](../../../packages/compute/README.md)（英文）。

**打包器。** 模块通过 `new URL('../wasm/<模块>.wasm', import.meta.url)` 定位。Vite、webpack 5、Rollup 和 Node 22 及以上版本都能解析它，并把 `.wasm` 文件作为资源复制出去；esbuild 需要为 `.wasm` 配置 `file` 加载器。服务器应以 `application/wasm` 发送这些文件。要从别处提供它们，把 URL（或字节）传给 `init({ sources: { compute: url } })`；它们也以 `@kgdiff/compute/compute.wasm`、`/formats.wasm` 和 `/layout.wasm` 导出。

**内容安全策略。** 编译 WebAssembly 需要在 `script-src` 中加入 `'wasm-unsafe-eval'`，例如 `Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'`。

从 0.11 起，`@kgdiff/core` 的 `diff` 和 `parseGraph`、`@kgdiff/layout` 的 `layoutDiff` 都是异步的，并在这个包上运行：`await diff(…)` 第一次调用时加载 `compute.wasm`，`await parseGraph(…)` 加载 `formats.wasm`。[迁移到 0.11](./migrating-to-0.11.md) 列出了所有变了签名的函数。

## 错误

所有 API 在输入有误时都会抛出 `KgdiffError`，带有 `code`（`invalid-input`、`delta-base-mismatch`、`delta-conflict`、`unsupported-version`）和 `details`。
