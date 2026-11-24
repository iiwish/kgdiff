# kgdiff 命令行

`kgdiff` 比较两个图文件，就像 `git diff` 比较两个文本文件一样：在终端里、在 CI 中，或者生成一份可以分享的单文件 HTML 报告。

```sh
npx @kgdiff/cli before.ttl after.ttl                 # 彩色摘要 + 变更列表
npx @kgdiff/cli before.obo after.obo -o report.html  # 自包含的交互式报告
npx @kgdiff/cli a.json b.json --json > diff.json     # 完整的机器可读 diff
npx @kgdiff/cli a.json b.json --delta > patch.json   # 只输出可反向的增量
npx @kgdiff/cli a.json b.json --markdown             # PR 评论 / 作业摘要
npx @kgdiff/cli a.obo b.obo --kgcl > changes.kgcl    # KGCL 命令（实验性）
npx @kgdiff/cli apply a.json patch.json -o b.json    # 应用增量
```

`npx @kgdiff/cli` 需要 Node.js ≥ 22。没有 Node.js 时，可以从 PyPI 安装同一个 `kgdiff`，包名是 `pykgdiff`（只带命令行），也可以从 crates.io 安装；下面的例子都直接写 `kgdiff`：

```sh
npm install --global @kgdiff/cli     # Node.js
pipx install pykgdiff                # Python 工具：或者 uv tool install pykgdiff、pip install pykgdiff
uvx --from pykgdiff kgdiff a.ttl b.ttl   # 不安装，运行一次
cargo install kgdiff                 # Rust
```

## 用法

```
kgdiff <before> <after> [options]
kgdiff apply <graph> <delta> [-o <file>] [--no-strict [--verbose]] [--verify-target] [--allow-empty]
kgdiff completion <bash|zsh|fish>
kgdiff --help | --version | help [apply|completion]
```

`<before>` / `<after>` 是文件路径，或者用 `-` 表示标准输入（最多一侧）。空输入（0 字节或只有空白，无论来自文件还是标准输入）视为输入错误，除非加上 `--allow-empty`，这时按空图读取。否则一侧悄悄变空，结果就会是“全部删除”。

### 输入格式

格式由扩展名决定：`.json`、`.jsonld`、`.ttl`、`.nt`、`.nq`、`.trig`、`.rdf`、`.owl`、`.obo`、`.graphml`、`.gexf`，也可以再套一层 `.gz`；其他文件名和标准输入则由内容决定。有两个扩展名会再看一眼内容：内容是 JSON-LD（顶层有 `@context`、`@graph`、`@id` 等）的 `.json` 按 JSON-LD 读取；`.owl` 按其实际包含的语法读取，因为 Protégé 也会用这个扩展名写 Turtle、OWL/XML 或函数式语法。kgdiff 能识别但不读取的格式（OWL/XML、OWL 函数式语法和 Manchester 语法）会报错并给出转换提示。JSON-LD 的 context 必须内联：kgdiff 从不获取远程 `@context`（这样运行始终离线、可复现），引用了远程 context 的文档会报错，并提示把它内联。

### 选择输出（默认：摘要写到标准输出）

| 选项                | 输出                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| _（无）_            | 标题行、统计，然后是变更组列表（类似 `git diff --stat` 加 `--name-status`，但按语义）    |
| `--stat`            | 只输出统计                                                                               |
| `--name-status`     | 每组一行：`A` 新增、`D` 删除、`M` 修改、`R` 改名、`V` 迁移、`G` 合并、`S` 拆分、`E` 关系 |
| `--json [file]`     | `DiffJSON`（加 `--pretty` 时格式化）                                                     |
| `--delta [file]`    | `Delta`                                                                                  |
| `--markdown [file]` | GitHub 风格的 Markdown：标题、统计表、可折叠的变更组列表                                 |
| `--kgcl [file]`     | 把变更写成 [KGCL](#kgcl-导出) 命令，供 OBO 工具使用（实验性）                            |
| `-o, --html <file>` | 自包含的 HTML 报告（查看器 + 内嵌数据；可离线使用）                                      |
| `--open`            | 用默认浏览器打开 HTML 报告                                                               |

多种输出可以组合（`-o report.html --markdown summary.md`），但最多只能有一种写到标准输出。`--json`、`--delta`、`--markdown` 和 `--kgcl` 可以跟一个文件名（`-` 或不写表示标准输出；以 `-` 开头的文件名写作 `--json=-x.json` 或 `--json ./-x.json`）。

输出文件以原子方式写入（先在同一目录写临时文件，再重命名；保留已有文件的权限）。已存在且不是普通文件的输出（如 `/dev/null` 或命名管道）直接写入。输出永远不会覆盖输入：比较的是（设备，inode），所以大小写不敏感文件系统上的大小写变体、符号链接和硬链接都能识别出来；两个输出也不会写到同一个文件。`kgdiff apply` 对 `-o` 采用同样的规则。`--open` 不带 `-o` 时，报告写到一个新建的私有临时目录（`mkdtemp`）。

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

遇到意外错误时，CLI 会给出一个错误报告链接，预先填好 CLI 版本、操作系统平台和架构。链接不会包含错误信息或输入路径；分享诊断输出前请先检查一遍。预期内的用法、输入和输出错误仍保留原有提示。

### Shell 补全

`kgdiff completion <bash|zsh|fish>` 把对应 shell 的补全脚本打印到标准输出。在 shell 启动时加载它：

```sh
eval "$(kgdiff completion bash)"     # 写在 ~/.bashrc 里
source <(kgdiff completion zsh)      # 写在 ~/.zshrc 里，compinit 之后
kgdiff completion fish | source      # 写在 ~/.config/fish/config.fish 里
```

bash 里要写 `eval`，不要写 `source <(…)`：macOS 自带的 bash 3.2 从进程替换里什么也读不到，而且不报错。

也可以把脚本写到 shell 读补全的目录里，写一次就行；升级 kgdiff 以后重新写一次，新版本可能有新的选项：

```sh
# bash：要装了 bash-completion 包（第 2 版）才会读这个目录，单有 bash 不会
kgdiff completion bash > ~/.local/share/bash-completion/completions/kgdiff

# zsh：放进 fpath 里一个自己的目录，在 ~/.zshrc 里 compinit 之前设置
mkdir -p ~/.zfunc && kgdiff completion zsh > ~/.zfunc/_kgdiff
#   fpath=(~/.zfunc $fpath)

# fish
kgdiff completion fish > ~/.config/fish/completions/kgdiff.fish
```

脚本能补全选项（长短两种写法）、取值固定的选项的值（`--format`、`--before-format`、`--after-format`、`--match`、`--edge-identity`、`--theme`、`--mode`、`--scope`、`--color`、`--locale`）、两个图文件和接受文件的选项的文件名，以及 `apply`、`help`、`completion` 这三个命令和它们各自的选项。脚本是从解析命令行用的同一批表生成的，所以列出的正好是打印它的那个版本的选项。`apply`、`help` 和 `completion` 只有作为第一个参数时才是命令：要比较叫这些名字的文件，把它写成路径（`./completion`）。

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

如果结果的哈希不是增量的 `target.hash`，而且没有跳过任何操作，`apply` 会在标准错误中给出警告，仍然写出结果（退出码 0）：增量被截断或改动过，或者来自一个漏掉了部分改动的 kgdiff 版本。加上 `--verify-target` 时，这样的结果算输入错误（退出码 2），什么也不写；报错信息给出两个哈希。同时使用 `--no-strict` 时也一样，不论有没有跳过操作：跳过了操作的结果，只有恰好仍是目标（图里已经有了那些改动）才能通过。没有 `target.hash` 的增量无法校验，所以 `--verify-target` 会拒绝它。

使用 `--ignore-attr` 时，差异不展示被忽略属性的改动，但增量仍然带上它们，所以应用增量能得到增量的目标（见[增量格式](delta-format.md#被忽略的属性)）。

## Markdown 摘要

用于 PR 评论和 `$GITHUB_STEP_SUMMARY`：标题、统计表（节点 / 关系 × 新增 / 删除 / 修改）、类别图例、按阶段分组、放在 `<details>` 块里的变更组列表（前 100 组，之后是“还有 N 组”），列表之前是一个 ⚑ “优先审查”块，列出修改了受关注属性的变更组（前 20 组；下面的分组可能默认折叠，其中相同的条目也标有 ⚑），以及单独放在一个 `<details>` 块里的可能的匹配，内容与终端相同（前 20 对；不超过 10 对时默认展开）。除了 `<details>/<summary>` 之外不含任何 HTML。标签都经过转义（Markdown 标点，包括用于公式的 `$`；`<`、`>`、`&` 转为实体；不可见字符和双向字符变为可见；控制字符删除），并且在转义前用零宽空格让 GitHub 在 Markdown 之后的过滤失效：`:emoji:` 短代码、`@提及`、`#123` / `org/repo#123` / `GH-123` 引用、裸露的 `scheme://` 网址和 `www.` 自动链接。摘要永远不会 @ 到别人、链接 issue，也不会把标签变成链接。

## KGCL 导出

**实验性**：映射可能在次版本中改变。

`--kgcl` 把变更写成 [KGCL](https://github.com/INCATools/kgcl)（Knowledge Graph Change
Language，OBO 工具读取的变更语言）：一份要应用到**旧版**文件上的变更清单，每行一条命令，按摘要里变更组的顺序，组内按增量操作的顺序。某条命令作为替代项引用的新建节点，会先于这条命令创建，即使它所在的变更组排在后面。同样的输入得到同样的字节。对应的库函数是 `kgdiff_report::render_kgcl`。

```sh
kgdiff mhd-2026-09.obo mhd-2026-10.obo --kgcl changes.kgcl
runoak -i simpleobo:mhd-2026-09.obo apply --no-expand --changes-input changes.kgcl -o mhd-applied.obo   # OAK
```

给 OAK 加上 `--no-expand`。默认（`--expand`）下 `runoak apply` 会把每条 `obsolete` 展开成更多改动：给标签再加一次 “obsolete ” 前缀，把该节点的子节点重接到它的父节点上，并删除它的关系。kgdiff 的输出已经把新版文件里的这些改动逐条写出来了（它的 `rename … to 'obsolete …'`、`delete edge` 和 `create edge`），再展开一次会改变结果。这个选项按 OAK 的 `cli.py` 里的定义写，kgdiff 的测试没有实际运行 OAK。

| kgdiff                          | KGCL                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| 新增节点                        | `create node X 'label'`（没有标签的节点写 `create X`）     |
| 删除节点                        | `delete X`                                                 |
| 新增 / 删除关系                 | `create edge S P O` / `delete edge S P O`                  |
| 标签改变                        | `rename X from 'old' to 'new'`                             |
| 新增同义词（别名）              | `create [exact\|narrow\|broad\|related] synonym 'a' for X` |
| 删除同义词                      | `remove synonym 'a' for X`                                 |
| 废弃（带一个新的 `replacedBy`） | `obsolete X [with replacement Y]`                          |
| 取消废弃                        | `unobsolete X`                                             |
| 新增定义                        | `add definition 'd' to X`                                  |
| 修改定义                        | `change definition of X from 'a' to 'b'`                   |
| 删除定义                        | `remove definition for X`                                  |
| 新增 / 删除类型（RDF 输入）     | `create edge X rdf:type T` / `delete edge X rdf:type T`    |

定义指的是属性 `def`（OBO）、`definition`、`IAO:0000115` 和 `skos:definition`。迁移（一个父节点换成另一个）写成它的 `delete edge S P OLD` 和 `create edge S P NEW`，不用 KGCL 的 `move`：OAK 的 simpleobo 实现遇到 move 只记一条警告、什么也不改，SQL 实现则直接抛出 `NotImplementedError`。

KGCL 不能改 id。id 改变写成注释，所有命令都用节点在旧版文件（命令要应用的那个文件）里的 id 指称它：`A:1` 改成 `A:2` 之后，标签改动写成 `rename A:1 …`。如果某个新节点占用了一个改过 id 的节点的旧 id，它就无法这样指称，它的改动写成注释。

KGCL 的关系是三元组。删除一条关系时如果还留着另一条来源、谓词和目标都相同的关系（平行边），或者新增一条关系时原来已经有相同的三元组，就写成注释：`delete edge` 会删掉新版文件里还保留的三元组，`create edge` 则什么也不加。输入是 OBO 时，只有 `is_a`（写成 `rdfs:subClassOf`）和 `relationship` 子句是 KGCL 能写的关系；`intersection_of`、`union_of`、`equivalent_to`、`disjoint_from` 和 `instance_of` 子句不是关系，它们的边写成注释。（kgdiff 把这两类子句都读成以标签名或关系名为谓词的边，所以关系名恰好与这些标签同名的 `relationship` 也会写成注释。）

其余变更没有对应的 KGCL 命令，写成**注释**：一行 `# <原因>: <JSON>`，JSON 是它代表的增量操作，与增量里一致，所以什么都不会丢。这些是：其他属性的改动（`xref`、`comment`、`rdfs:comment` 等）、id 改变、关系的标签和属性、`replaces` 以及不伴随废弃的 `replacedBy` 改动、RDF 以外输入的类型改动、隐式节点（文件里没有声明、只作为关系端点出现的节点），以及新节点或新关系里命令带不下的字段（在命令之后写一条注释）。拆分，以及不是“带替代的废弃”的合并，在它们的改动之前写一条说明。KGCL 无法加引号的文本也写成注释：KGCL 的字符串用单引号括起，没有转义，所以为空、含 `'` 或含换行的标签、同义词和定义都写不出来（例如 `Alzheimer's disease`）。删除定义不需要文本（`remove definition for X`）；修改定义时旧文本无法加引号，就不带旧文本写（`change definition of X to 'new'`，下面两份语法都支持）；`rename` 和同义词命令没有这种写法。kgdiff 会在标准错误输出一条警告，给出写成注释的改动条数，以及有字段留在注释里的新建节点和关系的个数；说明不计在内。OAK（`runoak apply`）会跳过 `#` 开头的行；KGCL 本身没有注释，别的读取方可能需要先去掉这些行（`grep -v '^#'`）。

用了 `--ignore-attr` 时，被忽略属性的改动照样导出，因为增量里照样有它们：这些命令是要把旧版文件变成新版文件的，`--ignore-attr` 只是把这个属性排除在比较之外。它们写在最前面，在所有变更组之前。

id 按 KGCL 接受的形式写：IRI 用两个文件自己声明的前缀（加上常用前缀和 OBO PURL 规则，`http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`）压缩成 CURIE，压缩不了就放在尖括号里（`<https://example.org/x>`）；其他 id 原样写出。含空白（按 Python 的定义，包括 `\u00a0`）、以引号或 `<` 开头的 id，以及压缩不了又含 `<` 或 `>` 的 IRI 写不出来，相应的改动写成注释。看起来像关键字的 id（`with`、`from`、`to`、`edge`、`node`）原样写出，下面两个解析器都会把它们读回成 id。输入是 OBO 时，`is_a` 写成 `rdfs:subClassOf`，同义词带上范围，stanza 类型 `Term` 不另写。

这些命令依据 INCATools/kgcl 在提交 `1849f9c`（2026-11-18）的语法 [`src/kgcl_schema/grammar/kgcl.lark`](https://github.com/INCATools/kgcl/blob/1849f9cbb3ebb4a5ee0e6c62b11238841eb81d66/src/kgcl_schema/grammar/kgcl.lark)，并且只用已发布的 `kgcl-schema` 0.7.0 也能解析的命令（0.7.0 没有 `add label`，所以给原来没有标签的节点加标签会写成注释）。`kgcl-schema` 的解析器只在认识尖括号里完整 IRI 的命名空间时（OBO、Bioregistry 和常见的关联数据前缀）才能解析它，其他 IRI 会被读成空值；这是那个解析器的限制，不是语法的限制。

## HTML 报告

单个文件：独立版查看器（`@kgdiff/viewer/standalone`）加上放在 `<script type="application/kgdiff+json">` 里的 `ReportPayload`（超过 512 kB 时用 gzip + base64，由 `DecompressionStream` 解码）。不需要联网；因为 diff 和布局已经由命令行算好，打开就能看。`--reproducible` 让相同的输入得到逐字节相同的报告。

当布局只覆盖变化部分时（图超过布局的大图阈值，`layout.scope: "changes"`），命令行还会在查看器之后内联查看器的计算插件（`@kgdiff/viewer/standalone/compute`，设置 `globalThis.KgdiffCompute`），这样折叠的分组可以在浏览器里展开并布局。布局完整的报告不内联它，以保持体积小；`--no-compute` 则始终不内联。缺少计算插件只是警告（报告照常写出），缺少查看器则是错误（退出码 2）。

文档结构：`<!doctype html>`；`lang` 取自语言设置；字符集、视口和 `<title>`；一段内联样式先画出主题背景（按 `prefers-color-scheme`，`--theme` 指定时以它为准），避免白屏闪烁；一个视觉上隐藏的 `<h1>`；`<main>` 里铺满视口的 `<kgdiff-viewer global-shortcuts>`（整个页面就是查看器，所以它的快捷键在整页生效）；一段 `<noscript>` 摘要；数据脚本；最后是查看器脚本。内联的 JSON 和 JavaScript 中从不出现 `</script` 和 `<!--`。查看器元素上只在给出时带 `mode` 和 `scope`；主题、语言和面板状态只放在数据的 `view` 里（写成属性会压过读者之前的选择），查看器读到数据后立即应用。

数据（`ReportPayload`，`format: "kgdiff.report"`，`version: 1`；JSON Schema 是 [`report.v1.json`](../../packages/core/schema/report.v1.json)）包含打包的 diff、布局、`meta`（标题、生成器、时间戳、两侧的名称和格式）和 `view`：`mode`、`scope`、`theme`、`locale`，以及从 kgdiff 0.6 起的 `panels`（区域到状态的对象，例如 `{ "detail": "collapsed" }`）。`view` 的每个字段都可省略；查看器忽略不认识或无效的字段（在控制台给出警告），所以没有 `panels` 的旧报告按默认布局打开。从 kgdiff 0.7 起 `layout` 也可省略：查看器读到没有布局的数据（不写这个成员）时，会在打开时用计算插件（`globalThis.KgdiffCompute`）给 diff 布局；缺少计算插件时，显示一条说明原因的错误。这个命令行总是写出布局。
