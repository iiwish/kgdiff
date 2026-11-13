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

- **JavaScript API**：`@kgdiff/*` 导出的一切及其类型，标了 `@experimental` 的除外（见下文）。`packages/*/api/` 里的 API 报告按入口逐个列出了它们。和 Rust crate 里标了 `#[doc(hidden)]` 的项一样，下面这些不在承诺之内：
  - `@kgdiff/core/computed`（`readComputedDiff` 及其类型）：内部入口，只有同版本的 `@kgdiff/compute` 调用它；
  - 继承查看器的元素类（`@kgdiff/viewer/elements/*`）。元素的公开接口是它的属性（attribute 和 property）、方法、事件、插槽和 CSS，也就是 `custom-elements.json` 列出的内容。声明文件里出现的基类（`BoundElement`、`ViewBoundElement`、`RootElement`）和子类会去覆盖的成员都是查看器自己的：声明文件里不含这些成员，任何版本都可能改动它们；
  - 标了 `@internal` 的项，声明文件里能去掉的都去掉了。
- **Rust API**：`kgdiff-core`、`kgdiff-formats`、`kgdiff-layout`、`kgdiff-report` 和 `kgdiff` 在 docs.rs 文档里显示的公开项。标了 `#[doc(hidden)]` 的不在承诺之内：它们是引擎自己的、在 kgdiff 的几个 crate 之间共用的东西（`kgdiff_core::js` 里除 `Value`、`Object`、`JsStr`、`json`、`IndexMap`、`IndexSet` 以外的 JavaScript 辅助函数；`canonical`、`text`、`util` 模块；`kgdiff_report` 的 `locale`、`model`、`width`；`kgdiff` crate 里除 `cli`、`io`、`system`、`testing` 以外的所有模块）。这四个模块是实验性的（见[下文](#实验性-api)）。宿主会去实现的 trait（`kgdiff::io::CliIo`）以后加的方法都带默认实现。只有一个依赖的类型属于公开 API：`IndexMap` 和 `IndexSet` 是 `indexmap` 2 的类型，所以 `indexmap` 升主版本就是 kgdiff 的主版本。
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

在 TypeScript 里，这些列表是字符串联合类型（`KgdiffErrorCode`、`FormatId`、`ParseWarningCode` 等）：新成员会在次版本里出现，所以对它们 `switch` 时要有 `default` 分支。选项对象新增的可选成员、结果新增的成员也都算新增。

有些枚举是模型里封闭的分类，代码应当逐个处理每个成员：`ChangeStatus`、`HunkKind`、`ReplayPhase`、`SuggestionReason`、`End` 和 `js::Value`。给它们加成员属于破坏性变更。

## 实验性 API

文档里标了 `@experimental` 的 API 可以在次版本里改，1.0 之后也一样。它们是渲染器的 `addLayer`、`LayerView` 和 `RendererLayer`，`@kgdiff/scene` 的节点形状、`shape1` 和 `shape2`，以及报告的 `shapes`。它们是为嵌入宿主设计的，目前还没有宿主用过。标记会一直保留，等真实宿主用过之后，在某个次版本里去掉；去掉标记只算新增，不算破坏性变更。

`kgdiff` crate 的嵌入接口同样是实验性的：它的 `cli`、`io`、`system` 和 `testing` 四个模块可能在次版本里变化。`CliIo` 的签名还带着从 JavaScript 移植过来的写法（`columns() -> Option<f64>`、`now() -> io::Result<String>`、路径用 `&str`），而且目前没有外部宿主在用。等 Python 绑定用过之后，再把这几个模块纳入承诺。`kgdiff-core`、`kgdiff-formats`、`kgdiff-layout` 和 `kgdiff-report` 不受影响。

## 平台

- **Node.js**：`engines` 列出的版本线（22 及以后），每条都在 CI 里测试。
- **Rust**：crate 的 `rust-version`（最低支持的 Rust 版本）不晚于六个月前的稳定版，只在次版本里提高。
- **浏览器**：能运行 WebAssembly 和查看器自定义元素的浏览器；查看器包本身不含 WebAssembly。

## 弃用

被弃用的东西在下一个主版本之前（1.0 之前是下一个次版本之前）都能继续用，它的文档会写明替代品。`@kgdiff/formats` 在 0.11.1 弃用，改用函数相同的 `@kgdiff/core`；从 0.12.1 起不再发布，旧版本仍在 npm 上。

## 安全修复

安全修复进最新的版本。1.0 起，支持当前主版本的最新次版本（[安全政策](https://github.com/iiwish/kgdiff/blob/main/.github/SECURITY.md)）。
