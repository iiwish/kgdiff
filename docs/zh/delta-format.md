# kgdiff 增量格式（v1）

**增量**（delta）是一种底层的、可反向、可校验的补丁，用来把图的一个版本变成另一个版本，相当于图的“unified diff”。语义（合并、迁移、改名……）放在 diff 的变更组里；增量只需要基本操作，这让 `apply` 和 `invert` 既简单又精确。类型：`packages/core/src/types.ts` 中的 `Delta` 和 `DeltaOp`。

## 外层结构

```json
{
  "format": "kgdiff.delta",
  "version": 1,
  "edgeIdentity": "structure",
  "base":   { "name": "go", "version": "2026-09-01", "hash": "c53:001f3a9c4b7e21", "nodes": 512, "edges": 1490 },
  "target": { "name": "go", "version": "2026-10-01", "hash": "c53:0a77c1e09f3d55", "nodes": 518, "edges": 1502 },
  "ops": [ … ]
}
```

- `hash` 是规范化后的图的 `hashGraph`（不含位置和元数据）。
- 读取方必须拒绝未知的 `format`，以及比自己支持的版本更高的 `version`（`KgdiffError('unsupported-version')`）。
- JSON Schema 是 [`delta.v1.json`](../../packages/core/schema/delta.v1.json)，随 `@kgdiff/core` 发布（`@kgdiff/core/schema/delta.v1.json`），也可以从 `https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/delta.v1.json` 获取。

## 操作

每个操作都带有检查前置条件和反向所需的信息。id 总是指前面的操作执行完之后图的状态。

| op            | 字段                                   | 前置条件                              | 反向                     |
| ------------- | -------------------------------------- | ------------------------------------- | ------------------------ |
| `node.rekey`  | `from`、`to`                           | `from` 存在，`to` 不存在              | `node.rekey` `to → from` |
| `edge.remove` | `edge`（EdgeJSON）                     | 关系存在且等于 `edge`                 | `edge.add`               |
| `node.remove` | `node`（NodeJSON，完整快照）           | 节点存在，等于 `node`，且没有关系     | `node.add`               |
| `node.set`    | `id`、`field`、`from`、`to`            | 当前值等于 `from`                     | 交换 `from` / `to`       |
| `node.attr`   | `id`、`key`、`from?`、`to?`            | 当前值等于 `from`（省略时表示不存在） | 交换                     |
| `node.add`    | `node`                                 | 节点不存在                            | `node.remove`            |
| `edge.add`    | `edge`                                 | 两个端点都存在，关系不存在            | `edge.remove`            |
| `edge.set`    | `edge`、`field: 'label'`、`from`、`to` | 当前标签等于 `from`                   | 交换                     |
| `edge.attr`   | `edge`、`key`、`from?`、`to?`          | 当前值等于 `from`                     | 交换                     |

`node.rekey` 更换节点的标识，并重新确定与它相连的关系的键（在 `structure` 模式下，端点变了，键也随之改变）。关系按标识定位：`structure` 模式下是由 `edge` 计算出的结构键，`id` 模式下是 `edge.id`。值的比较采用规范 JSON 相等（对象的键排序后比较）。

## 规范顺序

`node.rekey` → `edge.remove` → `node.remove` → `node.set` → `node.attr` → `node.add` → `edge.add` → `edge.set` → `edge.attr`，每组内部按 [algorithms.md §8](../algorithms.md#8-delta)（英文）的规定排序。`diff` 生成的增量总是规范的；`applyDelta` 接受任何满足前置条件的顺序。

## 保证

- `apply(A, diff(A, B).delta) ≅ B`，且 `apply(B, invert(diff(A, B).delta)) ≅ A`（≅：哈希相等）。
- 严格模式下，遇到第一个不满足的前置条件就立即失败，抛出 `KgdiffError('delta-conflict', …, { opIndex, op, reason })`；基准哈希不一致时抛出 `KgdiffError('delta-base-mismatch')`。
- 非严格模式（`strict: false`）跳过基准哈希检查和所有前置条件不成立的操作，并按操作顺序把每个被跳过的操作报告给 `ApplyOptions.onSkip({ index, op, reason })`，其中的 `reason` 和严格模式会抛出的文字相同。格式不正确的操作（未知类型、字段类型错误）在两种模式下都是输入错误：`KgdiffError('invalid-input')`。

## 已知限制：被忽略的属性

使用 `ignoreAttrs`（`--ignore-attr`）时，被忽略属性的改动不会进入增量，但 `target.hash` 是整个 after 图（含这些属性）的哈希。因此把这样的增量应用到 before 图上，得到的图的哈希与 `target.hash` 对不上，`kgdiff apply` 会警告结果与增量的目标不一致。上面的保证只对没有忽略属性时生成的增量成立。

## 与其他格式的关系

| kgdiff                               | KGCL（INCAtools）             | RDF Patch                |
| ------------------------------------ | ----------------------------- | ------------------------ |
| `node.add` / `node.remove`           | `create node` / `delete`      | 该节点三元组的 `A` / `D` |
| `node.set label`                     | `rename`                      | 标签三元组的 `D` + `A`   |
| `node.set deprecated` + `replacedBy` | `obsolete … with replacement` | 三元组                   |
| `edge.add` / `edge.remove`           | `create edge` / `delete edge` | `A` / `D`                |
| 变更组 `move`（diff 层面）           | `move … from … to …`          | `D` + `A`                |
| 变更组 `merge`（diff 层面）          | 带替代的废弃                  | 三元组                   |

导出到 KGCL 和 RDF Patch 的功能可以基于变更组和操作来实现，不需要改动这个格式。
