# 版本约定

kgdiff 遵循[语义化版本](https://semver.org/lang/zh-CN/)。本页说明版本号承诺什么：每一类版本里可以有哪些改动，以及哪些不在承诺之内。

## 所有东西共用一个版本号

所有 `@kgdiff/*` npm 包和 crates.io 上的所有 `kgdiff*` crate 都是同一个版本，crate 之间也按这个版本精确依赖：kgdiff X.Y.Z 指的是一套一致的包。所以任何一部分有破坏性变更，哪怕只有 Rust 代码看得到，所有包都要一起发破坏性版本。

| 版本                          | 1.0 之前（0.x）                     | 1.0 起           |
| ----------------------------- | ----------------------------------- | ---------------- |
| 补丁（0.12.**1**、1.0.**1**） | 只有修复，公开 API 和输出字节都不变 | 同左             |
| 次版本（0.**13**、1.**1**）   | 可以破坏公开 API                    | 只能新增         |
| 主版本（**2**.0）             | —                                   | 可以破坏公开 API |

## 承诺范围

- **JavaScript API**：`@kgdiff/*` 导出的一切及其类型，标了 `@experimental` 的除外（见下文）。
- **Rust API**：`kgdiff-core`、`kgdiff-formats`、`kgdiff-layout`、`kgdiff-report` 和 `kgdiff` 在 docs.rs 文档里显示的公开项。标了 `#[doc(hidden)]` 的不在承诺之内：它们是引擎自己的、在 kgdiff 的几个 crate 之间共用的东西（`kgdiff_core::js` 里除 `Value`、`Object`、`JsStr`、`json`、`IndexMap`、`IndexSet` 以外的 JavaScript 辅助函数；`canonical`、`text`、`util` 模块；`kgdiff_report` 的 `locale`、`model`、`width`；`kgdiff` crate 里除 `cli`、`io`、`system`、`testing` 以外的所有模块）。
- **命令行**：命令、选项、退出码，以及它写出的文件和机器可读的输出（`--json`、`--delta`、`--markdown`、HTML 报告）。提示信息和终端摘要的措辞可以在次版本里改。
- **文档格式**：差异 JSON、增量、布局文档和报告载荷都带格式版本号。同一版本的文档含义不变；读取方遇到比自己认识的更新的版本时拒绝读取（[增量格式](./delta-format.md)）。
- **输出字节**：同样的输入和选项，在所有平台、所有包里得到同样的字节。补丁版本从不改变它们；次版本可以改，比如布局算法改进时。这时新算法写出的布局会带一个不同的 `generator`（`kgdiff-layout/1`），缓存的布局据此就能分清新旧。

## 不升主版本也能加的东西

新增不算破坏，所以这些在次版本里就能加。Rust 类型的声明方式保证了它们在 Rust 里也是新增：

- 新的错误码、问题码、警告码；新的格式、语言、变化种类、匹配策略：列出它们的枚举都标了 `#[non_exhaustive]`，所以对它们 `match` 时要有 `_` 分支；
- 选项、输入和结果的新字段：这些结构体都标了 `#[non_exhaustive]`，所以宿主从 `Default::default()` 或构造函数开始，再设置自己需要的字段：

  ```rust
  let mut options = DiffOptions::default();
  options.edge_identity = EdgeIdentity::Id;
  ```

有些枚举是模型里封闭的分类，代码应当逐个处理每个成员：`ChangeStatus`、`HunkKind`、`ReplayPhase`、`SuggestionReason`、`End` 和 `js::Value`。给它们加成员属于破坏性变更。

## 实验性 API

文档里标了 `@experimental` 的 API 可以在次版本里改。1.0 之前，渲染器的图层（`addLayer`）、`@kgdiff/scene` 的节点形状和报告的 `shapes` 带着这个标记；1.0 去掉它，此后它们也在承诺之内。

## 平台

- **Node.js**：`engines` 列出的版本线（22 及以后），每条都在 CI 里测试。
- **Rust**：crate 的 `rust-version`（最低支持的 Rust 版本）不晚于六个月前的稳定版，只在次版本里提高。
- **浏览器**：能运行 WebAssembly 和查看器自定义元素的浏览器；查看器包本身不含 WebAssembly。

## 弃用

被弃用的东西在下一个主版本之前（1.0 之前是下一个次版本之前）都能继续用，它的文档会写明替代品。`@kgdiff/formats` 已弃用，改用 `@kgdiff/core`；它的 0.x 版本留在 npm 上，不发布 1.0。

## 安全修复

安全修复进最新的版本。1.0 起，支持当前主版本的最新次版本（[安全政策](https://github.com/iiwish/kgdiff/blob/main/.github/SECURITY.md)）。
