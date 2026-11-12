# 迁移到 0.11

kgdiff 0.11 在浏览器和 Node 里的所有计算都改由编译成 WebAssembly 的 kgdiff Rust 引擎
[`@kgdiff/compute`](../../../packages/compute/README.md) 执行：和 kgdiff 命令行是同一个引擎，输出逐字节相同。
编译 WebAssembly 是异步的，所以做计算的函数改为返回 Promise。0.11 是最后一个有破坏性变更的版本；1.0 是 0.11
稳定一段时间后的同一份代码（[RFC 0002](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0002-rust-compute-core.md#6-api-changes-and-versions)，英文）。

## 改成异步的函数

| 包                | 0.10                                                        | 0.11                                                                 |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `@kgdiff/core`    | `diff(before, after, options?): DiffResult`                 | `diff(before, after, options?): Promise<DiffResult>`                 |
| `@kgdiff/core`    | `matchNodes(before, after, options?): MatchResult`          | `matchNodes(before, after, options?): Promise<MatchResult>`          |
| `@kgdiff/core`    | `textSimilarity(a, b): number`                              | `textSimilarity(a, b): Promise<number>`                              |
| `@kgdiff/formats` | `parseGraph(text, options?): ParseResult`                   | `parseGraph(text, options?): Promise<ParseResult>`（已弃用）         |
| `@kgdiff/formats` | `detectFormat(text, filename?): FormatId`                   | `detectFormat(text, filename?): Promise<FormatId>`（已弃用）         |
| `@kgdiff/formats` | `compactIri(iri, prefixes?): string`                        | `compactIri(iri, prefixes?): Promise<string>`（已弃用）              |
| `@kgdiff/layout`  | `layoutDiff(diff, options?): LayoutResult`                  | `layoutDiff(diff, options?): Promise<LayoutResult>`                  |
| `@kgdiff/layout`  | `extendLayout(diff, layout, nodes, options?): LayoutResult` | `extendLayout(diff, layout, nodes, options?): Promise<LayoutResult>` |

`@kgdiff/layout` 新增三个同样是异步的函数：`layoutGraph(graph, options?)`、`layoutDiffOn(diff, previous, options?)`
和 `layoutAfter(diff, layout, options?)`，用来在多个版本之间保持同一张地图（含义见[在 Rust 应用中嵌入](./embedding.md)，
TypeScript 版相同）。

`@kgdiff/core` 的 `log2` 已随使用它的 TypeScript 引擎一起移除；请改用 `Math.log2`。`@kgdiff/formats` 保留 `FORMAT_EXTENSIONS`（同步）和它的类型；它的 TypeScript 解析器已移除，三个函数都由 kgdiff 的解析器执行（见上）。

### 两种迁移方式

**加 `await`。** 在 `async` 函数里或模块顶层，给上表中的每个函数调用加上 `await`：

```ts
import { diff } from '@kgdiff/core';
import { layoutDiff } from '@kgdiff/layout';

const result = await diff(before, after, options); // 原来是 diff(before, after, options)
const layout = await layoutDiff(result);
```

第一次调用会加载并编译所需的模块（`diff` 用 `compute.wasm`，布局用 `layout.wasm`，解析用 `formats.wasm`），之后的调用只是执行。

**先初始化一次，再同步调用。** 需要在循环里处理大量数据，或者代码必须保持同步时，先 `await` 一次 `@kgdiff/compute` 的 `init()`，
再用它的 `*Sync` 函数，返回的对象相同：

```ts
import { init, diffSync, layoutDiffSync, parseGraphSync } from '@kgdiff/compute';

await init(); // 三个模块都加载；只要部分模块用 init({ modules: ['compute'] })
const result = diffSync(before, after, options);
const layout = layoutDiffSync(result);
```

用这个正则可以找出所有调用：`\b(diff|matchNodes|textSimilarity|parseGraph|detectFormat|compactIri|layoutDiff|extendLayout)\(`；
之后 TypeScript 会报出每一处把 `Promise` 当成结果值使用的地方。

## Worker

在负责计算的 worker 里初始化：每个 worker 编译自己的模块（`await init()`，或第一次异步调用）。线程之间传
`kgdiff.diff` 文档的 JSON 文本（`@kgdiff/compute` 的 `json.diff`，或 `JSON.stringify(diffToJSON(result))`），
不要传 `DiffResult` 对象（里面有 Map 和闭包）；另一侧用同步的 `diffFromJSON` 读取。

## 打包器与 `.wasm` 文件的提供

`@kgdiff/compute` 用 `new URL('../wasm/<module>.wasm', import.meta.url)` 定位模块。Vite、webpack 5、Rollup 和
Node 22 及以上会解析它，并把文件作为资源复制出去；esbuild 需要给 `.wasm` 配置 `file` loader。服务器要以
`application/wasm` 类型提供这些文件。要从别处提供，把 URL 或字节传给 `init({ sources: { compute: url } })`；
这几个文件也以 `@kgdiff/compute/compute.wasm`、`/formats.wasm` 和 `/layout.wasm` 导出。

只读取差异的打包结果（`diffFromJSON`、`layoutFromJSON`、查看器展示一份报告）里没有 WebAssembly：只有调用计算类函数时，
这些包才会用动态 `import()` 加载 `@kgdiff/compute`。

## 内容安全策略（CSP）

编译 WebAssembly 需要在 `script-src` 里加 `'wasm-unsafe-eval'`，例如
`Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'`。展示带布局的报告不需要编译任何东西；
在只围绕变更布局的报告里展开折叠的分组才需要。

## 布局

位置由 kgdiff 的 Rust 布局引擎计算，也就是命令行从 0.7 起使用的那一个。同样的输入和选项下，得到的位置与 0.10 的 TypeScript 引擎相同：直到 0.10，一致性语料都在每个用例上检查两个引擎的结果一致，RFC 0002 记录了在 1,000 到 10,000 个节点的合成图上也是如此，所以已经存下的布局不需要重算。变的是文档：0.11 起写出的布局文档是第 2 版，
带 `generator` 字段；`layoutFromJSON` 能读第 1 版和第 2 版。0.10 存下的位置仍可作为钉位使用（`pinned`、`layoutDiffOn`）。
节点带 `position` 的图仍会锚定这些位置布局：`diff` 会把输入图里的位置保留在结果的节点上。

## `@kgdiff/formats` 已弃用

它的函数现在只是 `@kgdiff/compute` 解析器外面的一层异步包装：请改用 `@kgdiff/compute` 的 `parseGraph`、`detectFormat`
和 `compactIri`（或 `init()` 之后的 `*Sync` 版本）。类型仍留在 `@kgdiff/formats`，直到 2.0 移除这个包。`@kgdiff/cli`
从 0.10 起不再是 JavaScript 库：计算请用 `@kgdiff/compute`，生成报告请用 kgdiff 命令行或 `kgdiff-report` crate。

## 查看器

`<kgdiff-viewer>` 的 API 不变。`load()` 的解析、差异和布局都在 `@kgdiff/compute` 上进行。独立版附加脚本
`kgdiff-viewer-compute.js` 内联了仅布局的模块，所以单文件报告离线也能展开折叠的分组；在独立版查看器里用 `load()`
传入图时，页面的 import map 里还需要有 `@kgdiff/compute`，就像文本输入需要 `@kgdiff/formats` 一样。

## 不变的部分

- 所有 JSON 文档（图、差异、打包的差异、增量、布局）、哈希、分组标题、摘要和增量都与命令行逐字节相同；也与 0.10 相同，只是布局写成了第 2 版的文档（位置没有变）。
- 错误码和错误信息：失败时抛出的仍是 `code` 相同的 `KgdiffError`。
- 读取路径仍是同步的，不需要 WebAssembly：`normalize`、`isKGraph`、`graphToJSON`、`hashGraph`、`diffFromJSON`、
  `diffToJSON`、`packDiffJSON`、`unpackDiffJSON`、`applyDelta`、`invertDelta`、`formatHunk`、`facetLabel`、
  `predicateLabel`、`resolveOptions`、`layoutFromJSON`、`layoutToJSON`、`nodeRadius` 和 `estimateLabelWidth`。
- scene、renderer、viewer 和 G6 这几个包。

## 支持期

0.11 之前的 0.x 版本在 0.11 发布后的六个月内继续获得安全修复。
