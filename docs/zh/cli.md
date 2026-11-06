# kgdiff 命令行

`kgdiff` 比较两个图文件，就像 `git diff` 比较两个文本文件一样：在终端里、在 CI 中，或者生成一份可以分享的单文件 HTML 报告。

```sh
npx @kgdiff/cli before.ttl after.ttl                 # 彩色摘要 + 变更列表
npx @kgdiff/cli before.obo after.obo -o report.html  # 自包含的交互式报告
npx @kgdiff/cli a.json b.json --json > diff.json     # 完整的机器可读 diff
npx @kgdiff/cli a.json b.json --delta > patch.json   # 只输出可反向的增量
npx @kgdiff/cli a.json b.json --markdown             # PR 评论 / 作业摘要
npx @kgdiff/cli apply a.json patch.json -o b.json    # 应用增量
```

## 用法

```
kgdiff <before> <after> [options]
kgdiff apply <graph> <delta> [-o <file>] [--no-strict [--verbose]] [--allow-empty]
kgdiff --help | --version | help [apply]
```

`<before>` / `<after>` 是文件路径，或者用 `-` 表示标准输入（最多一侧）。空输入（0 字节或只有空白，无论来自文件还是标准输入）视为输入错误，除非加上 `--allow-empty`，这时按空图读取。否则一侧悄悄变空，结果就会是“全部删除”。

### 输入格式

格式由扩展名决定：`.json`、`.jsonld`、`.ttl`、`.nt`、`.nq`、`.trig`、`.rdf`、`.owl`、`.obo`，也可以再套一层 `.gz`；其他文件名和标准输入则由内容决定。有两个扩展名会再看一眼内容：内容是 JSON-LD（顶层有 `@context`、`@graph`、`@id` 等）的 `.json` 按 JSON-LD 读取；`.owl` 按其实际包含的语法读取，因为 Protégé 也会用这个扩展名写 Turtle、OWL/XML 或函数式语法。kgdiff 能识别但不读取的格式（OWL/XML、OWL 函数式语法和 Manchester 语法、GraphML、GEXF）会报错并给出转换提示。JSON-LD 的 context 必须内联：kgdiff 从不获取远程 `@context`（这样运行始终离线、可复现），引用了远程 context 的文档会报错，并提示把它内联。

### 选择输出（默认：摘要写到标准输出）

| 选项                | 输出                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| _（无）_            | 标题行、统计，然后是变更组列表（类似 `git diff --stat` 加 `--name-status`，但按语义）    |
| `--stat`            | 只输出统计                                                                               |
| `--name-status`     | 每组一行：`A` 新增、`D` 删除、`M` 修改、`R` 改名、`V` 迁移、`G` 合并、`S` 拆分、`E` 关系 |
| `--json [file]`     | `DiffJSON`（加 `--pretty` 时格式化）                                                     |
| `--delta [file]`    | `Delta`                                                                                  |
| `--markdown [file]` | GitHub 风格的 Markdown：标题、统计表、可折叠的变更组列表                                 |
| `-o, --html <file>` | 自包含的 HTML 报告（查看器 + 内嵌数据；可离线使用）                                      |
| `--open`            | 用默认浏览器打开 HTML 报告                                                               |

多种输出可以组合（`-o report.html --markdown summary.md`），但最多只能有一种写到标准输出。`--json`、`--delta` 和 `--markdown` 可以跟一个文件名（`-` 或不写表示标准输出；以 `-` 开头的文件名写作 `--json=-x.json` 或 `--json ./-x.json`）。

输出文件以原子方式写入（先在同一目录写临时文件，再重命名；保留已有文件的权限）。输出永远不会覆盖输入：比较的是（设备，inode），所以大小写不敏感文件系统上的大小写变体、符号链接和硬链接都能识别出来；两个输出也不会写到同一个文件。`kgdiff apply` 对 `-o` 采用同样的规则。`--open` 不带 `-o` 时，报告写到一个新建的私有临时目录（`mkdtemp`）。

### diff 选项

| 选项                                | 含义                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `-f, --format <fmt>`                | 两个文件的输入格式（`json`、`jsonld`、`turtle`、`ntriples`、`nquads`、`trig`、`rdfxml`、`obo`）；默认自动判断 |
| `--before-format`、`--after-format` | 单独指定某一侧                                                                                                |
| `--match <strategy>`                | `id`、`auto`（默认）、`similarity`                                                                            |
| `--threshold <n>`                   | 相似度匹配的接受阈值（默认 0.82）                                                                             |
| `--edge-identity <mode>`            | `structure`（默认）或 `id`                                                                                    |
| `--hierarchy <predicate>`           | 层级谓词（可重复）；指定后替换默认值                                                                          |
| `--ignore-attr <key>`               | 比较时忽略某个属性（可重复）                                                                                  |
| `--no-merges`、`--no-splits`        | 关闭合并 / 拆分检测                                                                                           |
| `--lang <tags>`                     | RDF 标签的语言偏好，逗号分隔（例如 `zh,en`）                                                                  |

### 报告选项

| 选项                              | 含义                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `--title <text>`                  | 报告标题（默认为 `<before> → <after>`）                              |
| `--theme <auto\|light\|dark>`     | 初始主题（默认 auto）                                                |
| `--locale <en\|zh-CN>`            | 界面和变更组标题的语言（默认取自 `LANG`，否则为 `en`）               |
| `--mode <overlay\|swipe\|replay>` | 查看器的初始对比方式（`changes` 等于叠加加 `--scope changes`）       |
| `--scope <all\|changes>`          | 显示整张图还是只看变更，可配合任意对比方式（大图默认 `changes`）     |
| `--panels <spec>`                 | 各面板的初始状态，例如 `"detail:collapsed minimap:hidden"`（见下文） |
| `--reproducible`                  | 不写生成时间（输入相同时，报告逐字节相同）                           |
| `--no-compute`                    | 从不内联查看器的计算插件（见 §HTML 报告）                            |

`--panels` 的写法与查看器的 [`panels` 属性](interaction.md#panels)相同：若干 `区域:状态`，用空格或逗号分隔；可以重复给出（同一区域以最后一次为准）。区域有 `list`、`detail`、`search`、`filters`、`dock`、`transport`、`legend`、`zoom`、`minimap`、`title` 和 `actions`；状态有 `open`（展开）、`collapsed`（收起）和 `hidden`（隐藏）。没写到的区域保持默认布局。写错的区域或状态是用法错误（退出码 2），并给出建议，例如 `Unknown panel region "detials" in --panels. Did you mean "detail"?`。

`--theme`、`--locale`、`--mode`、`--scope` 和 `--panels` 是报告的初始视图。查看器会记住读者自己的选择（主题、配色、语言、面板和尺寸；按源保存在 `localStorage` 里），读者再打开报告时，这些选择优先于报告的主题、语言和面板。

### 行为

| 选项                            | 含义                                               |
| ------------------------------- | -------------------------------------------------- |
| `--exit-code`                   | 两张图不同时以 1 退出（同 `git diff --exit-code`） |
| `-q, --quiet`                   | 不向标准输出写任何内容（适合配合 `--exit-code`）   |
| `--color <auto\|always\|never>` | 默认 auto（识别 TTY 和 `NO_COLOR`）                |
| `--limit <n>`                   | 摘要中最多列出的变更组数（默认 50；`0` 表示全部）  |
| `--watch-attr <key>`            | 修改时标记 ⚑、优先审查的属性（可重复）             |
| `--allow-empty`                 | 把空输入按空图读取，而不是报错                     |

环境变量：`NO_COLOR`；`FORCE_COLOR`（`0` 关闭；`1` / `2` / `3` 即使在真彩色终端上也精确使用 16 / 256 / 真彩色；其他值按终端的色深开启）；`COLORTERM`、`TERM`、`COLORFGBG`（色深、浅色背景）；`LC_ALL` / `LC_MESSAGES` / `LANG`（语言）；`COLUMNS`；`KGDIFF_MAX_INPUT`（解压后的输入大小上限，单位为字节或 `K` / `M` / `G`，默认 `1G`；更大的输入和 gzip 炸弹视为输入错误）；`DEBUG=kgdiff`（打印堆栈）。

退出码：`0` 成功（带 `--exit-code` 时表示没有差异），`1` 有差异（仅在带 `--exit-code` 时），`2` 用法或输入错误（信息写在标准错误中，除非设置 `DEBUG=kgdiff`，否则从不打印堆栈）。

遇到意外错误时，CLI 会给出一个错误报告链接，预先填好 CLI 版本、操作系统平台、架构和 Node.js 版本。链接不会包含错误信息或输入路径；分享诊断输出前请先检查一遍。预期内的用法、输入和输出错误仍保留原有提示。纯函数 `describeError` 和 `formatError` 接受一个可选的错误报告 URL；省略时保留原提示。

## 终端摘要

```
kgdiff  企业信用知识图谱本体 v12 → v13                                节点 74 · 关系 171

  +1 新增   −1 删除   ~6 修改   ⇄4 结构调整                            12 组共 23 处变化
  ++++−−−~~~~~~~⇄⇄⇄⇄⇄⇄⇄⇄⇄

  删除 1
  − 删除「抽查检查」及 2 条关系                          删除 · 类型 事件 · 原关联「经营风险」
  结构调整 4
  ⊕ 「法人代表」合并入「法定代表人」                     身份 · 依据替代声明 · 迁移 1 条关系
  ⇄ 「股权出质」移至「股权投资」下                       结构 · 原属「经营风险」
  ⇄ 「十大股东」的「持股」改为指向「上市公司」（原为「企业」）  结构
  …
  修改 6
  ~ 「高管任职」改名为「董监高任职」                     内容 · 别名 +1
  ~ 修改「企业」                                         内容 · 属性 +2 −1 · 关系 ~1
  …
  新增 1
  + 新增「受益所有人」及 3 条关系                        新增 · 类型 角色
```

- **标题行**：图的名称和版本；节点 / 关系总数（前后不同时显示为 `变化前 → 变化后`）。
- **计数**：每个阶段的变更组数，按类别着色；右侧是变化的元素数和变更组数。
- **条形图**：每个阶段变化元素的比例（按最大余数法取整）；无颜色时用 `+ − ~ ⇄`，有颜色时用按类别着色的 `█`。
- **分组**在所有地方（命令行、Markdown、查看器）都遵循回放的阶段顺序：删除 → 结构调整 → 修改 → 新增，即清理、重组、细化、生长。组内的变更组保持 core 给出的 `order`。唯一变化是层级迁移的修改组显示为结构变化。
- **右侧一栏**：类别，然后是变更组的副标题（空间不够时先截断副标题，标题优先）。
- **优先审查**：受关注属性的修改在差异里看起来很小，却可能改变已有数据的含义，因此会标记 ⚑。统计条下方有一行统计修改了这类属性的变更组数（`⚑ 优先审查：9 组变更修改了定义`），这些变更组所在的行也会在摘要最前面标出（`内容 · ⚑ 定义 · 属性 ~2`）。默认关注的是定义，即各格式给它的键名：`def`（OBO）、`definition`（kgdiff JSON）、`IAO:0000115`（RDF 形式的 OBO 本体）和 `skos:definition`，都显示为“定义”。`--watch-attr <key>`（可重复）会替换这份列表，例如在用 `rdfs:comment` 写定义的词表里（schema.org 就是这样）使用 `--watch-attr rdfs:comment`。只统计两个版本中都存在的节点的属性，`--ignore-attr` 优先。`--stat` 也会显示这一行。
- **可能的匹配**列在最后：kgdiff 考虑过、但没有采用的配对，一侧被列为删除、另一侧被列为新增。这样“删除 X、新增 Y”就能读成“X 也许变成了 Y”。每行给出两侧的名称（名称相同时附上各自的 id）、得分、没有采用的原因（低于 `--threshold`，或与其他候选过于接近），以及标签和邻居两方面的证据，按得分从高到低排列；最多 10 对（`--limit 0` 列出全部，`--json` 包含所有建议）。最后一行说明如何让它们配对。这一节单独对齐列宽，没有可列的内容时不出现。

  ```
    可能的匹配 1
    ≈ 「pitchblende」→「uraninite (pitchblende)」   72% · 低于阈值 82% · 名称 69% · 邻居 55%
    这些节点未配对，因此按删除或新增列出。如是同一节点，可补充别名或替换链接，或调低 --threshold。
  ```
- 宽度：在 TTY 上取终端宽度（终端没有报告宽度时依次取 `COLUMNS`、80），否则取 `COLUMNS`，再否则为 120；限制在 40 到 120 之间（更窄的终端使用 40 列布局）。宽度降到 40 列时每一行仍能放下：计数会换行，表格列和类型名会让出空间，标题和摘要以 `…` 截断。布局在着色之前按纯文本测量（考虑东亚字符宽度和字素簇），所以有无颜色时对齐完全一致。
- 不可信的文本（标签、id、文件名、错误中的解析器消息）从不原样输出到终端：C0 控制字符变成控制图符（`␛`），C1 控制字符变成 `�`，双向文本或不可见的格式字符（U+202A–U+202E、U+2066–U+2069、U+200B、U+2060、U+FEFF 等）变成可见的 `⟨U+202E⟩`；emoji 连接符保留。

`--name-status` 在 TTY 上输出对齐的列，否则输出 TSV（`字母`、锚点 id、标题）。`--stat` 额外输出节点 / 关系 × 新增 / 删除 / 修改 / 未变的统计表，以及按类型的行。

颜色遵循 [visual-language.md](../visual-language.md)（英文）中的类别（真彩色、ANSI 256 色或 16 色，识别 `NO_COLOR` / `FORCE_COLOR`）；没有颜色时，符号也能保证输出可读。

## 输入与 `apply`

输入可以是 gzip 压缩的，也可以是 UTF-16（自动识别）；无效的 UTF-8 会报错。`kgdiff apply` 接受 `Delta` 或完整的 `DiffJSON`（来自 `--json`）作为补丁，可以来自文件或标准输入，并写出 kgdiff JSON（`graphToJSON`，带有 `kgdiff.graph` 格式标记），所以连续 apply 可以无损往返。在需要图的地方传入 diff 或增量文件，会被拒绝，并且报错信息会说明这是什么文件。`kgdiff help` 和 `-v` 分别是 `--help` 和 `--version` 的别名。

如果图不是增量的基准，会被拒绝（退出码 2）；提示会说明，图必须按生成增量时的方式解析（相同的 `--format` / `--lang`）。`--no-strict` 会应用所有前置条件成立的操作，并在标准错误中报告跳过了多少个；`--verbose` 逐个列出（`#序号 操作: 原因`）。

## Markdown 摘要

用于 PR 评论和 `$GITHUB_STEP_SUMMARY`：标题、统计表（节点 / 关系 × 新增 / 删除 / 修改）、类别图例、按阶段分组、放在 `<details>` 块里的变更组列表（前 100 组，之后是“还有 N 组”），列表之前是一个 ⚑ “优先审查”块，列出修改了受关注属性的变更组（前 20 组；下面的分组可能默认折叠，其中相同的条目也标有 ⚑），以及单独放在一个 `<details>` 块里的可能的匹配，内容与终端相同（前 20 对；不超过 10 对时默认展开）。除了 `<details>/<summary>` 之外不含任何 HTML。标签都经过转义（Markdown 标点，包括用于公式的 `$`；`<`、`>`、`&` 转为实体；不可见字符和双向字符变为可见；控制字符删除），并且在转义前用零宽空格让 GitHub 在 Markdown 之后的过滤失效：`:emoji:` 短代码、`@提及`、`#123` / `org/repo#123` / `GH-123` 引用、裸露的 `scheme://` 网址和 `www.` 自动链接。摘要永远不会 @ 到别人、链接 issue，也不会把标签变成链接。

## HTML 报告

单个文件：独立版查看器（`@kgdiff/viewer/standalone`）加上放在 `<script type="application/kgdiff+json">` 里的 `ReportPayload`（超过 512 kB 时用 gzip + base64，由 `DecompressionStream` 解码）。不需要联网；因为 diff 和布局已经由命令行算好，打开就能看。`--reproducible` 让相同的输入得到逐字节相同的报告。

当布局只覆盖变化部分时（图超过布局的大图阈值，`layout.scope: "changes"`），命令行还会在查看器之后内联查看器的计算插件（`@kgdiff/viewer/standalone/compute`，设置 `globalThis.KgdiffCompute`），这样折叠的分组可以在浏览器里展开并布局。布局完整的报告不内联它，以保持体积小；`--no-compute` 则始终不内联。缺少计算插件只是警告（报告照常写出），缺少查看器则是错误（退出码 2）。

文档结构：`<!doctype html>`；`lang` 取自语言设置；字符集、视口和 `<title>`；一段内联样式先画出主题背景（按 `prefers-color-scheme`，`--theme` 指定时以它为准），避免白屏闪烁；一个视觉上隐藏的 `<h1>`；`<main>` 里铺满视口的 `<kgdiff-viewer global-shortcuts>`（整个页面就是查看器，所以它的快捷键在整页生效）；一段 `<noscript>` 摘要；数据脚本；最后是查看器脚本。内联的 JSON 和 JavaScript 中从不出现 `</script` 和 `<!--`。查看器元素上只在给出时带 `mode` 和 `scope`；主题、语言和面板状态只放在数据的 `view` 里（写成属性会压过读者之前的选择），查看器读到数据后立即应用。

数据（`ReportPayload`，`format: "kgdiff.report"`，`version: 1`）包含打包的 diff、布局、`meta`（标题、生成器、时间戳、两侧的名称和格式）和 `view`：`mode`、`scope`、`theme`、`locale`，以及从 kgdiff 0.6 起的 `panels`（区域到状态的对象，例如 `{ "detail": "collapsed" }`）。`view` 的每个字段都可省略；查看器忽略不认识或无效的字段（在控制台给出警告），所以没有 `panels` 的旧报告按默认布局打开。
