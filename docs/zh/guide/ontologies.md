# 本体：OBO 与 OWL

## 格式

kgdiff 读取 OBO 1.4，以及以 RDF 序列化的 OWL 本体：RDF/XML（Protégé 和 ROBOT 默认写出的 `.owl` 文件）、Turtle、N-Triples 和 JSON-LD。OWL/XML、函数式语法和 Manchester 语法能被识别出来，但会被拒绝并给出提示。请先把它们转换成 RDF/XML 或 Turtle，例如用 [ROBOT](https://robot.obolibrary.org)：

```sh
robot convert --input onto.owx --output onto.owl
```

## 推荐选项

```sh
kgdiff release-1.obo release-2.obo --match id
```

- **`--match id`**：本体的 id（CURIE、IRI）按设计就是稳定的，所以只按 id 配对术语。废弃的术语仍会通过 `replaced_by`（OBO）或 `IAO:0100001`（OWL，“term replaced by”）和替代它的术语配对，并报告为合并。默认的 `auto` 还可能按标签相似度把一个删掉的术语和一个新术语配成一对。
- **`--hierarchy <predicate>`**：哪些谓词表示术语位于某个父类之下，这样父类变化时才会显示为“移至……下”。默认是 `rdfs:subClassOf`、`rdfs:subPropertyOf`、`skos:broader`、`is_a`、`subClassOf` 和 `parent`。指定 `--hierarchy` 会替换默认值；需要多个时重复使用，例如 `--hierarchy is_a --hierarchy part_of`，把部分–整体关系也当作层级。
- **`--lang <tags>`**（RDF）：一个术语有多种语言的标签时显示哪一种，例如 `--lang en` 或 `--lang zh,en`。
- **`--ignore-attr <key>`**：忽略每次发布都会变的注解（可重复）。键名在 OBO 里是标签名，例如 `creation_date`；在 RDF 里是缩写后的谓词，例如 `dcterms:date`。报告的详情面板里能看到它们。
- **`--watch-attr <key>`**：定义的修改会在摘要和 PR 评论里标记 ⚑、优先审查：OBO 里是 `def`，RDF 里是 `IAO:0000115` 和 `skos:definition`。改写后的定义可能改变已有注释的含义。也可以改为关注其他键名，例如 schema.org 风格的词表用 `--watch-attr rdfs:comment`。

## kgdiff 报告什么

| 你的修改                                       | kgdiff 的报告                                |
| ---------------------------------------------- | -------------------------------------------- |
| 用 `replaced_by` 或 `IAO:0100001` 废弃一个术语 | 「旧术语」合并入「新术语」（身份）           |
| 废弃一个术语，但不给替代                       | 弃用「术语」（内容）                         |
| 修改术语的父类（`is_a`、`rdfs:subClassOf`）    | 「术语」移至「新父类」下，原属「旧父类」     |
| 修改标签                                       | 「旧标签」改名为「新标签」（内容）           |
| 编辑同义词、定义、交叉引用、注释               | 修改「术语」，或修改「术语」的属性（内容）   |
| 用几个新术语取代一个术语                       | 「术语」拆分为「a」和「b」（身份），附置信度 |
| 增删存在量词约束（`part_of some X`）           | 关系的新增、删除或改指向（结构）             |

[ontology-release 示例](../../../examples/datasets/ontology-release)涵盖了其中大部分：

```
  结构调整 7
  ⊕ 「juvenile diabetes」和「insulin-dependent diabetes mell…   身份 · 依据替代声明 ·…
  ⊕ 「heart attack」合并入「myocardial infarction」             身份 · 依据替代声明 ·…
  ⊕ 「chronic obstructive airway disease」合并入「chronic ob…   身份 · 依据替代声明 ·…
  ⇄ 「Crohn disease」移至「inflammatory bowel disease」下       结构 · 原属「intestinal…
  ⇄ 「Hashimoto thyroiditis」移至「autoimmune thyroid diseas…   结构 · 原属「hypothyroi…
  ⇄ 「tuberculosis」移至「bacterial infectious disease」下      结构 · 原属「lung disea…
  ⑂ 「diabetes insipidus」拆分为「arginine vasopressin defic…   身份 · 推断 · 置信度 80…
```

这几处合并来自 `replaced_by`：废弃的术语保留为已弃用状态，原有的关系也被转移过去。拆分则没有 `replaced_by`（被废弃的术语只写了 `consider`）：kgdiff 之所以推断出拆分，是因为新术语以旧术语的同义词命名，并接过了它的关系；它同时会报告自己有多大把握。`--no-merges` 和 `--no-splits` 可以关闭合并和拆分检测。

## 局限

kgdiff 比较的是本体所描述的图：术语、标签、同义词、注解、层级和存在量词约束（`SubClassOf R some C` 会变成一条从该术语指向 `C` 的关系）。它不运行推理机；其他类表达式（并集、全称约束、等价类定义）会显示为匿名节点，而不是可读的公理。要审阅逻辑公理，请同时使用 `robot diff` 这类公理级的工具。
