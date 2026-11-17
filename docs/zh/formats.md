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
| GraphML     | `.graphml`                          | NetworkX、igraph、yEd、Gephi、LightRAG 写出的文件；按 node-link 数据读取           |
| GEXF        | `.gexf`                             | 1.1 到 1.3，Gephi 和 NetworkX 写出的文件；按 node-link 数据读取                    |

以上格式都可以用 gzip 压缩（`.gz`），编码可以是 UTF-8 或 UTF-16。

## 格式判断

格式由扩展名决定；没有可识别的扩展名或从标准输入（`-`）读取时，由内容决定。有两个扩展名会再看一眼内容：内容是 JSON-LD 的 `.json` 文件按 JSON-LD 读取；`.owl` 文件按其实际使用的语法读取，因为 Protégé 也会用这个扩展名保存 Turtle、OWL/XML 和函数式语法。

要跳过格式判断，用 `--format <fmt>` 指定两个输入的格式，或用 `--before-format` / `--after-format` 只指定一侧：可选 `json`、`jsonld`、`turtle`、`ntriples`、`nquads`、`trig`、`rdfxml`、`obo`、`graphml` 或 `gexf`。

## 能识别但不读取的格式

| 格式                                     | 怎么办                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| OWL/XML、OWL 函数式语法、Manchester 语法 | 转换成 RDF/XML 或 Turtle：`robot convert --input onto.owx --output onto.owl` |

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

[`graph.v1.json`](../../packages/core/schema/graph.v1.json) 是 kgdiff JSON 的 JSON Schema。`@kgdiff/core` 里带有它（`@kgdiff/core/schema/graph.v1.json`），也可以从 `https://cdn.jsdelivr.net/npm/@kgdiff/core/schema/graph.v1.json` 获取。在文件的 `$schema` 里写上它，编辑器就能补全和检查；也可以在 kgdiff 读取之前，用它校验流水线的产出，例如 LLM 的结构化输出。这份 Schema 描述的是规范形式：kgdiff 也能读更宽松的文件，比如数字 id、写在 `name` 里的标签，以及会归入 `attrs` 的其他字段。同一目录下的 `diff.v1.json` 和 `delta.v1.json` 分别描述 `--json` 和 `--delta` 写出的内容，`report.v1.json` 描述 HTML 报告里嵌入的数据，`diff-packed.v1.json` 和 `layout.v2.json` 描述其中打包的 diff 和布局。

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

无论哪种 JSON 结构，超出双精度范围的数字（`1e400`）都会保留为字符串 `"Infinity"` 或 `"-Infinity"`，并给出警告，而不是被丢掉。字符串里单独转义的半个代理对（`"\ud800"`）会报错：kgdiff 只读取合法的 Unicode 文本。

## GraphML

GraphML 文档先读成 NetworkX 对同一张图给出的 node-link 数据，再和其他 JSON 图一样处理：上面那些字段的含义不变。

| GraphML                                         | 变成                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `<node id>`                                     | 节点 id                                                             |
| `<edge source target>`、`<edge id>`             | 一条边，以及它的 id                                                 |
| 节点或边的 `<data key>`                         | 一个字段，名字是 key 的 `attr.name`：标签、类型、关系名或属性       |
| 图的 `<data key>`：`name`、`version`            | 图的名称和版本                                                      |
| `attr.type` 为 `int`、`long`、`float`、`double` | 数字                                                                |
| `attr.type` 为 `boolean`                        | 布尔值（`true`、`false`、`1`、`0`，以及 Python 的 `True`、`False`） |
| key 的 `<default>`                              | 没有为这个 key 写 `<data>` 的节点或边都取这个值                     |
| yEd 的 `<y:NodeLabel>`、`<y:EdgeLabel>`         | 节点或边的标签（没有别的字段充当标签时）                            |

**方向。** 有向边的两端按文件里写的顺序保留。无向边（`edgedefault="undirected"`，或边上写了 `directed="false"`）的两端按固定顺序排列，所以 `a – b` 和 `b – a` 是同一条边：图库按遇到节点的先后写两端，同一次抽取跑两遍，顺序就可能不同。

方向本身不是 kgdiff 比较的图的一部分：它只决定边的两端按什么顺序排，别无他用。一张图在前一版里存成有向、后一版里存成无向，两端相同，比较结果是没有变化。保留方向计划在 kgdiff 0.13 做，因为它会改变现在已经能读的文件读出来的内容。

**和 node-link JSON 是同一张图。** NetworkX 把一张有向图分别存成 GraphML 和 node-link JSON，在 kgdiff 看来是同一张图，拿这两个文件比较不会有变化。有两种情况例外，要等 kgdiff 0.13 用同样的方式读 node-link JSON：无向图在 JSON 里把一条边写成 `b – a` 时（JSON 保留文件里的顺序）；以及多重图，它的平行边在 JSON 里带 `key` 字段，在 GraphML 里没有。

**边的 id。** NetworkX 把多重图平行边的 key 写成 `<edge id>`，每一对节点都从 0 数起。两条边共用的 id 不算 id：这时 kgdiff 不从文件里读任何边 id，并给出警告（`graphml-shared-edge-ids`）。

节点 id、边的两端和边的 id 以元素自己的属性为准：名叫 `id`、`source` 或 `target` 的字段不会替换它们。

kgdiff 不读取的内容会略过并给出警告，不会报错：

- 嵌套的图（yEd 的分组）和第一个之后的 `<graph>` 元素会合并成一张图（`graphml-merged-graphs`）；
- `<hyperedge>` 和 `<port>` 被跳过（`graphml-unsupported-elements`）；
- 内容是 XML 的 `<data>` 被丢弃，yEd 等编辑器把几何位置和样式放在这里；yEd 的标签除外（`graphml-ignored-data`）；
- 和 key 声明的类型不符的值（`long` 写成 `about 175`，`double` 写成 `inf`）保留为文本（`graphml-invalid-value`）。超出双精度能精确表示的 `long`（`9007199254740993`）也保留为文本，以免丢掉数字，和 RDF 一样；它符合自己的类型，所以没有警告。

有一个限制：一份文档的 `<default>` 最多可以补出和文件字节数一样多的字段（小文件按一百万算）。超过的文件会被拒绝，因为一个默认值在文件里只占一行，却要给图里每个节点加一个字段。

LightRAG 把实体的类型放在 `entity_type` 里，它不在类型字段之列：除非你用 `parseGraph` 的 `json.fields.type` 指明，否则它只是一个属性（JSON 读取器的字段覆盖对 GraphML 同样生效）。

## GEXF

GEXF（1.1 到 1.3）的读法和 GraphML 一样：先读成 node-link 数据，再和其他 JSON 图一样处理。

| GEXF                                            | 变成                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `<node id label>`                               | 节点 id 和标签                                    |
| `<edge source target>`、`id`、`label`、`weight` | 一条边，以及它的 id、标签和数字属性 `weight`      |
| `<edge kind>`（GEXF 1.3）                       | 关系名；没有它时用边的标签                        |
| `<edge type>`                                   | 方向；其他取值是关系名（见下）                    |
| `<attvalue for value>`                          | 一个字段，名字是属性的 `title`，类型按它的 `type` |
| `type` 为 `integer`、`long`、`float`、`double`  | 数字                                              |
| `type` 为 `boolean`                             | 布尔值                                            |
| 属性的 `<default>`                              | 同一类里没有写 `<attvalue>` 的节点或边都取这个值  |
| `<graph name>`                                  | 图的名称                                          |

有两处是照着 NetworkX 的写法来的。它给每个节点都写 `label`，节点没有标签时写的就是 id：只是重复 id 的标签不算标签，这时节点的 `name` 或 `title` 充当标签，和 node-link JSON 一样。它还把名叫 `type` 的边属性写成边的 `type`：不是 `directed`、`undirected`、`mutual` 的 `type` 就按这个属性读，也就是关系名。

方向和 GraphML 相同：无向边（图的 `defaultedgetype`，或边自己的 `type`）的两端按固定顺序排列。除此之外不保留方向：`mutual` 按 `directed` 读，边的 `type` 变了，比较结果是没有变化。Gephi 和 NetworkX 给边编的号会读成边的 id；除非指定 `--edge-identity id`，否则它们不参与比较。所以一张有向图存成 GEXF 和 node-link JSON 是同一张图；无向图和多重图的差别同 GraphML 一节所述。`<default>` 能补出多少字段的限制也和 GraphML 相同。

以下内容会略过并给出警告：

- `viz:` 元素，里面是位置、颜色、大小和形状（`gexf-ignored-viz`）；
- 时间：动态图按一张静态图读取，随时间变化的属性取文件里排在最后的那个值（`gexf-dynamic`）；
- 层级：节点里面的节点，或带 `pid`、`<parents>` 的节点，都当作普通节点（`gexf-hierarchy`）；
- 和属性声明的类型不符的值保留为文本（`gexf-invalid-value`）；超出双精度能精确表示的整数保留为文本但没有警告，和 GraphML 一样。

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
