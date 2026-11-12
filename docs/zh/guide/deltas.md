# 增量：应用与反向

增量（delta）用一串操作描述从一张图到另一张图的变化，这些操作新增、删除或更新节点和关系，并附带基准图和目标图的内容哈希。增量是可反向的：反向增量能把目标图还原成基准图。操作按规范顺序排列，所以同一份 diff 总是得到同一个增量。JSON 格式见[增量格式](../delta-format.md)。

## 写出增量

```sh
kgdiff before.obo after.obo --delta patch.json
```

这条命令写出增量，同时照常打印摘要；加 `-q` 可以不打印。`kgdiff apply` 也接受 `--json` 写出的完整 diff。

## 应用增量

```sh
kgdiff apply before.obo patch.json -o patched.json
```

```
✓ Wrote patched graph (115 operations applied, c53:1019a1b806733b) patched.json (79 kB)
```

`kgdiff apply` 把打过补丁的图写成 [kgdiff JSON](../formats.md#kgdiff-json)，kgdiff 可以无损读回。拿它和目标图核对一下：

```sh
kgdiff after.obo patched.json --exit-code -q && echo 完全一致
```

## 基准必须一致

增量只能应用到它的基准图上。kgdiff 会先比较内容哈希，遇到其他图一律拒绝，退出码为 2：

```
$ kgdiff apply after.obo patch.json -o patched.json
error: <graph> "after.obo" is not the base of this delta (graph c53:1019a1b806733b, delta base c53:099a5149fa1cd6).
hint: If it is the same graph, parse it as when the delta was made: --format and --lang must match the options given to `kgdiff … --delta` (they change what the graph contains). Otherwise --no-strict applies what fits and reports the rest.
```

解析选项之所以重要，是因为它们会改变图的内容：换一个 `--lang` 就会选出别的标签。`--no-strict` 会应用所有前置条件成立的操作，并在标准错误中报告跳过了多少个；加上 `--verbose` 会逐个列出。

## 反向应用

命令行只能正向应用增量。在代码中，`invertDelta` 可以得到反向增量：

```ts
import { readFile } from 'node:fs/promises';
import { applyDelta, invertDelta, normalize } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/compute';

const delta = JSON.parse(await readFile('patch.json', 'utf8'));
const after = await parseGraph(await readFile('after.obo', 'utf8'), { filename: 'after.obo' });
const before = applyDelta(normalize(after.graph), invertDelta(delta));
```

## 用途

- 以补丁形式发布更新，用户可以核对自己手里的副本是否正好是补丁针对的那个版本。
- 保留审阅通过的变化：查看器的 `exportDelta()` 返回当前 diff 的增量。
- 用反向增量撤销一次变化。

`kgdiff apply` 写出的是 kgdiff JSON，不会写回 Turtle 或 OBO。
