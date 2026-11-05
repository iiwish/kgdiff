# 格式

| 格式        | 扩展名                              | 说明                                                                               |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Turtle      | `.ttl`                              |                                                                                    |
| N-Triples   | `.nt`                               |                                                                                    |
| N-Quads     | `.nq`                               | 命名图会被合并，并给出警告                                                         |
| TriG        | `.trig`                             | 命名图会被合并，并给出警告                                                         |
| RDF/XML     | `.rdf`、`.owl`                      | 完整的 RDF 1.1 XML 语法，Protégé 和 ROBOT 写出的文件都能读                         |
| JSON-LD 1.1 | `.jsonld`、带 `@context` 的 `.json` | context 必须内联：不会联网获取任何内容                                             |
| OBO 1.4     | `.obo`                              | 同义词、`is_a`、relationship、带 `replaced_by` 的废弃、`alt_id`                    |
| JSON 图     | `.json`                             | kgdiff、d3 / NetworkX node-link、Cytoscape.js、AntV G6 v5、graphology、vis-network |

以上格式都可以用 gzip 压缩（`.gz`），编码可以是 UTF-8 或 UTF-16。

## 格式判断

格式由扩展名决定；没有可识别的扩展名或从标准输入（`-`）读取时，由内容决定。有两个扩展名会再看一眼内容：内容是 JSON-LD 的 `.json` 文件按 JSON-LD 读取；`.owl` 文件按其实际使用的语法读取，因为 Protégé 也会用这个扩展名保存 Turtle、OWL/XML 和函数式语法。

要跳过格式判断，用 `--format <fmt>` 指定两个输入的格式，或用 `--before-format` / `--after-format` 只指定一侧：可选 `json`、`jsonld`、`turtle`、`ntriples`、`nquads`、`trig`、`rdfxml` 或 `obo`。

## 能识别但不读取的格式

| 格式                                     | 怎么办                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| OWL/XML、OWL 函数式语法、Manchester 语法 | 转换成 RDF/XML 或 Turtle：`robot convert --input onto.owx --output onto.owl` |
| GraphML、GEXF                            | 改为导出 JSON，例如 NetworkX node-link 数据或 Cytoscape.js JSON              |

kgdiff 会在错误信息里说明是什么格式、该怎么转换。

## kgdiff JSON

kgdiff 自己的格式，也是 `kgdiff apply` 写出的格式：

```json
{
  "format": "kgdiff.graph",
  "version": 1,
  "meta": { "name": "zoo", "version": "v2" },
  "nodes": [
    { "id": "animal", "label": "Animal" },
    { "id": "mammal", "label": "Mammal" },
    {
      "id": "cat",
      "label": "Domestic cat",
      "type": "Species",
      "aliases": ["house cat"],
      "attrs": { "legs": 4 }
    },
    { "id": "dog", "label": "Dog", "type": "Species" }
  ],
  "edges": [
    { "source": "mammal", "target": "animal", "predicate": "subClassOf" },
    { "source": "cat", "target": "mammal", "predicate": "subClassOf" },
    { "source": "dog", "target": "mammal", "predicate": "subClassOf" }
  ]
}
```

| 字段                                     | 含义                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `format`、`version`                      | `"kgdiff.graph"` 和 `1`：可以不写，但要写就一起写；见下文            |
| `meta.name`、`meta.version`              | 显示在标题行和标题里                                                 |
| `nodes[].id`                             | 必填，且唯一                                                         |
| `nodes[].label`                          | 显示名称；标签变化即改名                                             |
| `nodes[].type`                           | 一个类型，或类型数组                                                 |
| `nodes[].aliases`                        | 别名、同义词                                                         |
| `nodes[].attrs`                          | 其他任意值：字符串、数字、布尔值、数组                               |
| `nodes[].deprecated`                     | 废弃的节点为 `true`                                                  |
| `nodes[].replacedBy`、`nodes[].replaces` | 替代节点的 id，有了它们，删除会变成合并                              |
| `edges[].source`、`edges[].target`       | 节点 id，必填                                                        |
| `edges[].predicate`                      | 关系；[层级谓词](./guide/ontologies.md#推荐选项)上的变化会显示为迁移 |
| `edges[].id`、`label`、`attrs`           | 可选                                                                 |

假设第一个版本里猫和狗直接位于“Animal”之下，猫的标签还只是“Cat”，那么和上面这个版本比较，结果是：

```
kgdiff  zoo v1 → v2                              节点 3 → 4 · 关系 2 → 3

  +1 新增   ~1 修改   ⇄1 结构调整                        3 组共 6 处变化
  ++~~⇄⇄

  结构调整 1
  ⇄ 「Dog」移至「Mammal」下         结构 · 原属「Animal」
  修改 1
  ~ 「Cat」改名为「Domestic cat」   内容 · 别名 +1 · 移至「Mammal」下
  新增 1
  + 新增「Mammal」及 1 条关系       新增 · 关联「Animal」
```

### 格式标记与 JSON Schema

和 diff、增量一样，kgdiff 写出图时会把 `"format": "kgdiff.graph"` 和 `"version": 1` 放在最前面。没有这两个字段的文件照样能读，按结构识别。有这两个字段的文件会直接按 kgdiff JSON 读取，不再猜测结构；kgdiff 不支持的版本会被拒绝；在需要图的地方传入 diff 或增量文件，也会被拒绝，并且报错信息会说明这是什么文件。

[`graph.v1.json`](../../packages/core/schema/graph.v1.json) 是 kgdiff JSON 的 JSON Schema。`@kgdiff/core` 里带有它（`@kgdiff/core/schema/graph.v1.json`），也可以从 `https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/graph.v1.json` 获取。在文件的 `$schema` 里写上它，编辑器就能补全和检查；也可以在 kgdiff 读取之前，用它校验流水线的产出，例如 LLM 的结构化输出。这份 Schema 描述的是规范形式：kgdiff 也能读更宽松的文件，比如数字 id、写在 `name` 里的标签，以及会归入 `attrs` 的其他字段。同一目录下的 `diff.v1.json` 和 `delta.v1.json` 分别描述 `--json` 和 `--delta` 写出的内容，`diff-packed.v1.json` 描述 HTML 报告里嵌入的打包 diff。

## 其他 JSON 图结构

kgdiff 会识别 JSON 的结构（d3 / NetworkX node-link、Cytoscape.js、AntV G6 v5、graphology、vis-network），并读取以下字段：

| 概念       | 字段                               |
| ---------- | ---------------------------------- |
| 节点 id    | `id`、`key`、`data.id`             |
| 标签       | `label`、`name`、`title`           |
| 类型       | `type`、`types`、`category`……      |
| 别名       | `aliases`、`synonyms`              |
| 关系       | `edges`、`links`、`elements.edges` |
| 废弃与替代 | `deprecated`、`replacedBy`         |

节点的其他字段会成为属性。只和绘制有关的字段（渲染状态、样式、形状类型）会被丢弃，并给出警告。

## RDF 与 OBO

- 主语成为节点。OBO 的 PURL 会缩写成 `GO:0008150` 这样的 CURIE。
- 标签取自 `rdfs:label`、`skos:prefLabel`、`schema:name` 等；`--lang` 选择语言。OBO 使用 `name`。
- `rdf:type` 给出节点类型；类型不是关系。
- 字面量值成为属性；值为 IRI 的成为关系。
- OWL 存在量词约束（`C SubClassOf R some D`）成为一条从 `C` 指向 `D` 的关系。
- `owl:deprecated` 和 `IAO:0100001`（“term replaced by”），以及 OBO 的 `is_obsolete`、`replaced_by` 和 `alt_id`，都会成为废弃标记和替代关系。
- 空白节点根据自身内容和上下文得到稳定的 id。
- 对语句的注解（`owl:Axiom`、`rdf:Statement`）会并入被注解的关系。

同一张图无论用哪种 RDF 语法写，结果都相同。完整规则见 [Architecture：mapping conventions](../architecture.md#formats-mapping-conventions)（英文）。

## 输入与限制

- 一侧可以从标准输入读取，写作 `-`。
- 空输入会报错，除非加上 `--allow-empty`，这时按空图读取。
- 输入解压后最大 1 GB；`KGDIFF_MAX_INPUT` 可以调高上限，例如 `KGDIFF_MAX_INPUT=4G`。
- 无效的 UTF-8 会报错，语法错误会指出所在行。
