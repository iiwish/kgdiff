# 没有稳定 id 的图

LLM 抽取流水线（GraphRAG 之类）通常每次运行都会生成新的 id。按 id 比较两次运行的结果，会把每个节点都报告成删除后又新增，等于什么也没说。

[llm-extraction 示例](../../../examples/datasets/llm-extraction)里是同一篇文章的两次抽取结果。在它上面比较三种匹配策略：

| `--match`      | 结果              | 原因                                        |
| -------------- | ----------------- | ------------------------------------------- |
| `id`           | 2 组共 193 处变化 | 没有任何共同的 id：节点全删、全增           |
| `auto`（默认） | 42 组共 58 处变化 | 节点按相似度配上了对，但每一对都报告换了 id |
| `similarity`   | 30 组共 45 处变化 | 忽略 id：剩下的就是两次运行真正不一致的地方 |

所以当 id 没有意义时，按相似度匹配：

```sh
kgdiff run-a.json run-b.json --match similarity
```

```
kgdiff  curie-extraction run-a → run-b                       节点 39 → 40 · 关系 55 → 59

  +3 新增   −2 删除   ~24 修改   ⇄1 结构调整                           30 组共 45 处变化
  +++++++++−−−−−~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~⇄

  删除 2
  − 删除「Albert Einstein」及 1 条关系                          删除 · 类型 Person · 原…
  − 删除「pitchblende」及 2 条关系                              删除 · 类型 Mineral ·…
  结构调整 1
  ⇄ 删除关系「Pierre Curie」—discovered→「Thorium」             结构 · 关系已删除
  修改 24
  ~ 「Marie Curie」改名为「Marie Skłodowska-Curie」             内容 · 属性 ~1 · 别名 +…
  ~ 「polonium (Po)」改名为「Polonium」                         内容
  ~ 「uranic rays」改名为「Becquerel rays」                     内容 · 别名 +2
  …
  新增 3
  + 新增「uraninite (pitchblende)」及 2 条关系                  新增 · 类型 Mineral ·…
  + 新增「French Academy of Sciences」及 2 条关系               新增 · 类型 Organizatio…
  + 新增「Gustave Bémont」及 2 条关系                           新增 · 类型 Person · 关…
```

“Albert Einstein”是第二次运行去掉的一个幻觉实体；那些改名是同一实体的不同写法；“French Academy of Sciences”和“Gustave Bémont”是只有第二次运行抽到的实体。

## 相似度匹配是怎么工作的

kgdiff 把每个未匹配的节点和另一个版本中可能的候选逐一比较。评分时标签的权重最大（别名也算在内），其次是邻居结构（它已经匹配上的邻居有多少是一致的），再次是类型和属性。一对节点的得分达到阈值、并且明显高于其他所有候选时，才会匹配；具体过程见 [Algorithms](../../algorithms.md)（英文）。

- **`--threshold <n>`**（默认 0.82）：调低可以配上更多写法不同的变体，但有把不同实体配成一对的风险；调高则只配标签几乎相同的节点。
- **差一点配上的会成为建议。** 得分低于阈值但高于 0.6，或者和其他候选不相上下的一对，不会被匹配。终端摘要和 Markdown 摘要会把它列在“可能的匹配”下，查看器则列在节点的详情面板里。上面的“pitchblende”和“uraninite (pitchblende)”就是这样一对：

  ```
    可能的匹配 1
    ≈ 「pitchblende」→「uraninite (pitchblende)」   72% · 低于阈值 82% · 名称 69% · 邻居 55%
  ```

  更多例子见 [kgdiff 如何区分各种变化](./matching.md)。
- **关系按结构识别**，也就是按起点、谓词和终点（`--edge-identity structure`，默认），所以随机生成的关系 id 不影响结果。关系 id 有意义时，用 `--edge-identity id`。

## 每次都会变的属性

抽取器常会附带每次运行都不同的值：置信度、文本块 id、时间戳。忽略它们，就不会被当成变化：

```sh
kgdiff run-a.json run-b.json --match similarity --ignore-attr confidence --ignore-attr chunk_id
```

## 属性图格式

kgdiff 能读取大多数图库导出的 JSON：kgdiff 自己的格式、d3 和 NetworkX 的 node-link 数据、Cytoscape.js、AntV G6 v5、graphology 和 vis-network。[格式](../formats.md)列出了它读取的字段。用 Python 和 NetworkX 导出：

```python
import json

import networkx as nx

with open("run-a.json", "w") as f:
    json.dump(nx.node_link_data(graph), f)
```
