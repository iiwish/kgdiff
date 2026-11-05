# 在代码中使用引擎

命令行工具和查看器都由下面这些包构建而成，你也可以直接使用它们：

| 包                 | 作用                                                        |
| ------------------ | ----------------------------------------------------------- |
| `@kgdiff/core`     | diff 引擎：规范化、匹配、分类、分组、可反向的增量。无依赖。 |
| `@kgdiff/formats`  | 解析器：把 RDF、OBO 和 JSON 图格式读成 kgdiff 的图。        |
| `@kgdiff/layout`   | 确定性、考虑标签的布局，两个版本共用。                      |
| `@kgdiff/scene`    | 把 diff 转成视觉元素：设计令牌、编码、回放时间线。          |
| `@kgdiff/renderer` | Canvas 2D 渲染器：相机、细节层级、标签、拾取、小地图。      |
| `@kgdiff/viewer`   | [`<kgdiff-viewer>` Web 组件](./viewer.md)。                 |
| `@kgdiff/g6`       | 在 AntV G6 v5 中绘制 kgdiff 场景。                          |
| `@kgdiff/cli`      | 命令行工具 `kgdiff`。                                       |

它们都只提供 ESM，可在 Node.js 22 及以上版本和主流现代浏览器中运行。core 和 formats 都是同步的，不做任何 I/O：传入文本和对象，得到对象。

## 比较两张图

```sh
npm install @kgdiff/core @kgdiff/formats
```

```ts
import { readFile } from 'node:fs/promises';
import { diff, formatHunk } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';

const read = async (file: string) => parseGraph(await readFile(file, 'utf8'), { filename: file });
const before = await read('before.obo');
const after = await read('after.obo');

const result = diff(before.graph, after.graph, { match: { strategy: 'id' } });

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
diff(before.graph, after.graph, {
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
- `graphToJSON(graph)`：kgdiff JSON 格式的图，`parseGraph` 可以无损读回。
- `result.delta` 本身就是普通 JSON，格式见[增量格式](../delta-format.md)。

这三种 JSON 都写明了自己的 `format`（`kgdiff.diff`、`kgdiff.graph`、`kgdiff.delta`）和 `version`，并且在 `@kgdiff/core/schema/` 里各有一份 JSON Schema（见[格式](../formats.md#格式标记与-json-schema)）。读取方遇到不支持的版本，会抛出 `KgdiffError('unsupported-version')`。

## 布局与绘制

这些查看器都会替你做好。如果要构建自己的界面：

- `@kgdiff/layout` 的 `layoutDiff(result)` 为两张图的并集确定位置，结果是确定性的。
- `@kgdiff/scene` 的 `buildScene(result, layout)` 按 [kgdiff 视觉语言](../../visual-language.md)（英文）把 diff 转成视觉元素。
- `@kgdiff/renderer` 把场景画在 canvas 上；`@kgdiff/g6` 把它画进 AntV G6 图里。

各包的 README 展示了每一步：[layout](../../../packages/layout/README.md)、[scene](../../../packages/scene/README.md)、[renderer](../../../packages/renderer/README.md) 和 [g6](../../../packages/g6/README.md)。

## 错误

所有 API 在输入有误时都会抛出 `KgdiffError`，带有 `code`（`invalid-input`、`delta-base-mismatch`、`delta-conflict`、`unsupported-version`）和 `details`。
