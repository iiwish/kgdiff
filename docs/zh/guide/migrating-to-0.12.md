# 迁移到 0.12

kgdiff 0.12 为 1.0 整理公开 API。Rust API 给 1.0 之后计划中的新增留出位置，让它们都不需要升主版本（[版本约定](../versioning.md)）。JavaScript API 收到只剩有文档的部分：几个只有 kgdiff 自己的包在用的导出去掉了或隐藏了（[见下文](#javascript)）。命令行、文档格式和每一个输出字节都和 0.11 相同；对命令行来说，升级只是换个版本号。从 0.12.1 起，补丁版本只带修复和新增；下一批破坏性变更在 0.13 里，攒起来一起发（[版本约定](../versioning.md)）。1.0 要等条件满足才发，不定日期（[1.0 什么时候发](../versioning.md#1-0-什么时候发)）。

## JavaScript

通过属性、方法和事件使用查看器元素的页面和应用，以及按文档使用其他包的代码，都不用改。改动的地方：

- **`@kgdiff/viewer/elements/*`**：元素类的声明里不再出现子类会去覆盖的成员（`build`、`name`、`shadow`、`context`、`upgradedProperties`，以及 `<kgdiff-root>` 的 `actions`、`connected`、`createSession`、`sheets` 等钩子），也不再有 `KgdiffStage` 的 `view`。继承元素类不属于公开 API（[版本约定](../versioning.md)）：要扩展元素，请用组合的方式（插槽、`addLayer`、`registerObstacle`、事件）。
- **`@kgdiff/viewer/elements/stage`**：不再导出 `STAGE_REGIONS`。这些区域就是 `@kgdiff/viewer` 的 `StageRegion` 类型：`['dock', 'transport', 'legend', 'zoom', 'minimap']`。`stageContext` 的类型 `Context` 现在一起导出。
- **`@kgdiff/compute/layout`**：不再导出 `layoutModule`。请调用 `init()` 和这个入口的函数。
- **`@kgdiff/core/computed`** 是 `@kgdiff/compute` 的内部入口，不受语义化版本保护。
- **新增**：`@kgdiff/g6` 导出 `ElementKind`，即 `KgdiffDatumData.kgdiff` 的类型。
- **`@kgdiff/scene`**：`EdgeVisual` 和 `GlyphVisual` 的 `shape2` 和 `shape1` 一样是实验性的（本意一直如此，只是原来的文档只给 `shape1` 标了）。
- 每个入口现在都有一份 API 报告 `packages/<name>/api/*.api.md`，CI 会把它和构建出的声明文件对比。

## 选项、输入和结果标了 `#[non_exhaustive]`

在定义它们的 crate 之外，这些类型的结构体字面量不能再编译，带不带 `..Default::default()` 都一样。改成从 `Default::default()` 或构造函数开始，再设置字段：

```rust
// 0.11
let options = DiffOptions {
    edge_identity: graph.edge_identity(),
    ..DiffOptions::default()
};

// 0.12
let mut options = DiffOptions::default();
options.edge_identity = graph.edge_identity();
```

```rust
// 0.11
input.nodes.push(NodeInput {
    label: Some(label.into()),
    ..NodeInput::new(id)
});

// 0.12
let mut node = NodeInput::new(id);
node.label = Some(label.into());
input.nodes.push(node);
```

| crate            | 用 `Default::default()` 构造                                                    | 用构造函数                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kgdiff-core`    | `DiffOptions`、`MatchOptions`、`NormalizeOptions`、`ApplyOptions`、`GraphInput` | `NodeInput::new(id)`、`EdgeInput::new(source, predicate, target)`、`KgdiffError::new(code, message)`                                                                                                                        |
| `kgdiff-formats` | `ParseOptions`、`RdfOptions`、`JsonFields`                                      | —                                                                                                                                                                                                                           |
| `kgdiff-layout`  | `LayoutOptions`                                                                 | —                                                                                                                                                                                                                           |
| `kgdiff-report`  | —                                                                               | `ReportInfo::new(title, generator, before, after)`、`ReportSide::new(name, format)`、`ViewerBundles::new(main, compute)`（`const fn`）、`MarkdownOptions::new(locale, title, generator)`、`TextContext::new(paint, locale)` |

构造函数把其余字段留为默认值：`ReportInfo::new` 得到一份可复现的报告，用查看器自己的默认设置（所有 `Option` 都是 `None`，默认语言）；`TextContext::new` 是 80 列、列出所有块、默认的关注属性键；`MarkdownOptions::new` 是默认的关注属性键。字段仍然是公开的，其他的照旧设置。

kgdiff 返回的结果也标了 `#[non_exhaustive]`（`DiffResult`、`Hunk`、`UnionNode`、`UnionEdge`、`NodeMatch`、`MatchSuggestion`、`DiffStats`、`Delta`、`ParseResult`、`LayoutResult` 等）：字段照旧读取；用模式解构它们时要加 `..`。

## 会扩充的枚举标了 `#[non_exhaustive]`

对下面这些枚举做 `match` 时要有 `_` 分支：`ErrorCode`、`GraphIssueCode`、`Locale`、`MatchStrategy`、`MatchMethod`、`EdgeIdentity`、`DanglingEdges`、`Via`、`Cause`、`FacetKind`、`NodeFacet`、`EdgeFacet`、`DeltaOp`、`NodeField`（`kgdiff-core`）；`FormatId`、`JsonDialect`、`ParseWarningCode`、`CompactWith`、`LoadedDocument`（`kgdiff-formats`）；`LayoutStrategy`、`LayoutScope`（`kgdiff-layout`）；`ReportLayout`、`Tone`（`kgdiff-report`）。

`NodeFacet` 和 `EdgeFacet` 里带命名字段的成员也标了 `#[non_exhaustive]`，这样一种变化以后可以多带一个字段：它们的模式要加 `..`：

```rust
// 0.11
if let NodeFacet::Attrs { changes } = facet { /* … */ }
// 0.12
if let NodeFacet::Attrs { changes, .. } = facet { /* … */ }
```

`ChangeStatus`、`HunkKind`、`ReplayPhase`、`SuggestionReason`、`End` 和 `js::Value` 保持穷尽：宿主应当逐个处理它们的每个成员。

## 从文档里隐藏的内部实现

下面这些仍然是公开的（kgdiff 的几个 crate 之间要共用），但从文档里隐藏了，不受语义化版本保护：`kgdiff-core` 的 `canonical`、`text`、`util` 模块，以及 `kgdiff_core::js` 里除 `Value`、`Object`、`JsStr`、`json`、`IndexMap`、`IndexSet`、`BuildHasher` 以外的所有东西；`kgdiff-report` 的 `locale`、`model`、`width` 模块，以及 crate 根从中重新导出的语言相关函数（`format_int`、`match_locale`、`messages`、`resolve_locale`）；`kgdiff` 里除 `cli`、`io`、`system`、`testing` 以外的所有模块。用到它们的代码在 0.12 上还能编译，但之后任何一个版本都可能破坏它。

## `js::BuildHasher` 改成 kgdiff 自己的类型

`IndexMap` 和 `IndexSet` 是 `indexmap` 的映射加上 `kgdiff_core::js::BuildHasher`。它原来就是 `foldhash::fast::RandomState`，现在是 kgdiff 自己的类型（连同它的 `Hasher`），这样升级 foldhash 不会改变 kgdiff 的公开类型。用 `kgdiff_core::js::IndexMap` 这个名字的代码不用改；原来为它们写 `foldhash::fast::RandomState` 的代码改用 `kgdiff_core::js::BuildHasher`。

## 命令行 crate 的嵌入接口

给用自己的 `CliIo` 运行 `kgdiff::cli::run` 的宿主：

- `CliIo::viewer_bundle` 的返回类型从 crate 内部的 `Failure` 改为 `Result<Cow<'static, str>, ViewerMissing>`（`kgdiff::io::ViewerMissing::new(message, hint)`）。以后给 `CliIo` 加的方法都带默认实现。
- `FileStat` 标了 `#[non_exhaustive]`：用 `FileStat::new(dev, ino, size)`。
- `ViewerBundle` 标了 `#[non_exhaustive]`：对它 `match` 时要有 `_` 分支。
- `SystemIo` 标了 `#[non_exhaustive]`：用 `SystemIo::default()` 代替 `SystemIo`。
