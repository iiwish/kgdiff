# 在 Rust 应用中嵌入 kgdiff

kgdiff 的引擎是一组 Rust crate，画面是一组 npm 包。本指南跟着一个两者都用的应用走一遍：服务端用 Rust 保存一张图的各个版本，网页里展示这张图以及它发生的变化。内容按这样一个宿主实际做事的顺序写，围绕它依赖的那一条承诺：**同一张心智地图**。从一个版本切到下一个版本，或者从任一版本切到两者的 diff，节点都不能动。

下面每个 Rust 函数都摘自 `kgdiff-report` 的 [`examples/embedding.rs`](../../../crates/kgdiff-report/examples/embedding.rs)（`cargo run -p kgdiff-report --example embedding`）。有一条测试在[一致性语料](../../../conformance/README.md)每个用例的两张图上运行这些函数，并检查本页对它们的说法（[`tests/mental_map.rs`](../../../crates/kgdiff-report/tests/mental_map.rs)）。

`layout_graph`、`layout_diff_on`、`layout_after`、`report_payload_with` 和渲染器的 `addLayer` 是 0.9 新增的，在 1.0 之前为实验性，1.0 转正（[RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md) 的第 1、2、4a 部分，英文）。该 RFC 的其余部分见[还没有的东西](#还没有的东西)。

## 依赖什么

| 位置   | 包                                    | 用途                                         |
| ------ | ------------------------------------- | -------------------------------------------- |
| 服务端 | `kgdiff-core`                         | 图、diff、增量                               |
| 服务端 | `kgdiff-layout`                       | 单张图的布局、diff 的布局、布局文档          |
| 服务端 | `kgdiff-report`                       | 摘要、报告载荷、HTML 报告                    |
| 服务端 | `kgdiff-formats`（可选）              | 把 RDF、OBO 和其他 JSON 形状读成 kgdiff 的图 |
| 浏览器 | `@kgdiff/viewer`                      | 完整的审阅界面 `<kgdiff-viewer>`             |
| 浏览器 | `@kgdiff/scene` 和 `@kgdiff/renderer` | 自己的界面：视觉模型，以及绘制它的画布       |
| 浏览器 | `@kgdiff/core` 和 `@kgdiff/layout`    | 从载荷里读出 diff 和布局，交给场景           |

```toml
[dependencies]
kgdiff-core = "0.9"
kgdiff-layout = "0.9"
kgdiff-report = "0.9"
```

- **几个 crate 一起升级。** 每个 crate 都要求其他 crate 与自己的版本完全相同（`kgdiff-report` 0.9.0 依赖 `kgdiff-core = "=0.9.0"`），所以 Cargo 会把三者解析到同一个发布版本；如果你写的版本要求之间没有共同的版本，解析会失败。给它们写相同的版本要求，并一起更新。
- **npm 包与 crate 是同一个版本号**：kgdiff 0.9.0 指的是一套互相一致、一起测试过的包。npm 包装成与 crate 相同的版本（`npm install @kgdiff/viewer@^0.9.0`）。
- 1.0 之前，次版本可能改动接口。Cargo 里的 `"0.9"` 和 npm 里的 `^0.9.0` 都只在 0.9 之内升级。
- 从服务端传到浏览器的文档各有自己的版本（`kgdiff.report` 1、`kgdiff.diff.packed` 1、`kgdiff.layout` 2），JSON Schema 在 [`@kgdiff/core/schema/`](../formats.md#格式标记与-json-schema) 里。

本页的函数共用这些导入：

```rust
use std::error::Error;

use kgdiff_core::js::{Value, json};
use kgdiff_core::{
    DiffOptions, DiffResult, EdgeInput, GraphInput, KGraph, Locale, NodeInput, NormalizeOptions,
    Result, diff_graphs, graph_to_json, normalize, normalize_input,
};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, layout_after, layout_diff_on, layout_from_json, layout_graph,
    layout_to_json,
};
use kgdiff_report::{
    MarkdownOptions, Painter, ReportInfo, ReportLayout, ReportSide, TextContext, ViewerBundles,
    build_report_html_with, embedded_viewer, needs_compute, render_markdown, render_summary,
    report_payload_with,
};
```

## 导出一个版本并规范化

图以 [kgdiff JSON](../formats.md#kgdiff-json) 的形式进入 kgdiff：`{ "nodes": […], "edges": […] }`。你的导出写出这样的文本或 `kgdiff_core::js::Value`，`normalize` 把它变成其他函数都要用的 `KGraph`：

```rust
pub fn read_graph(export: &str) -> std::result::Result<KGraph, Box<dyn Error>> {
    let value = json::parse(export)?;
    Ok(normalize(&value, NormalizeOptions::default())?)
}
```

- `normalize` 做校验和索引：标签默认取 id，重复的节点会合并，边上不存在的端点会补成隐式节点。它修补了什么，记在 `graph.issues()` 里。
- `normalize_json` 直接接受文本，逐个元素读入，不会把整个文档先变成一棵值树：导出很大时，它用的内存少得多。
- `KGraph` 通过方法读取：`nodes()`、`node(id)`、`edges()`、`edge(key)`、`outgoing(id)`、`incoming(id)`、`meta()`、`issues()`。节点是 `&KGNode`，边是 `EdgeRef`，字段都用方法读（`label()`、`types()`、`source()` 等）。

如果应用里的图本来就是一组值，可以不写 JSON，直接构造同一张图：`normalize_input` 接受一个 `GraphInput`，成员与 kgdiff JSON 相同，给出的图与 `normalize` 对 `input.to_value()` 给出的相同，`graph_to_json` 的字节、指纹和 issues 都一样（一致性语料在每一张图上检查这一点）。属性值仍是 `kgdiff_core::js::Value`。下面的例子里，应用有一些概念和指标，每个指标记着它度量的是哪个概念：

```rust
pub fn build_graph(
    name: &str,
    concepts: &[(&str, &str)],
    metrics: &[(&str, &str, &str)],
) -> Result<KGraph> {
    let mut input = GraphInput::default();
    input.meta.insert("name", name);
    for &(id, label) in concepts {
        input.nodes.push(NodeInput {
            label: Some(label.into()),
            types: vec!["concept".into()],
            ..NodeInput::new(id)
        });
    }
    for &(id, label, measured_on) in metrics {
        input.nodes.push(NodeInput {
            label: Some(label.into()),
            types: vec!["metric".into()],
            ..NodeInput::new(id)
        });
        input
            .edges
            .push(EdgeInput::new(id, "measured_on", measured_on));
    }
    normalize_input(input, NormalizeOptions::default())
}
```

- 其他格式的文件（Turtle、OBO、JSON-LD 等）用 [`kgdiff-formats`](../../../crates/kgdiff-formats/README.md) 的 `parse_graph` 读，结果里是同样的 JSON。

## 给第一个版本布局

`layout_graph` 给一张图算出位置。按定义，也按测试，这些位置就是 `layout_diff` 给“这张图与它自己的 diff”算出的位置：一张图和它的 diff 由同一个引擎布局，结果相同。

```rust
pub fn first_map(graph: &KGraph) -> Result<(LayoutResult, String)> {
    let layout = layout_graph(graph, &LayoutOptions::default())?;
    let document = json::to_string(&layout_to_json(&layout));
    Ok((layout, document))
}
```

把布局文档和它所属的版本存在一起，需要时再读回来：

```rust
pub fn stored_map(document: &str) -> std::result::Result<LayoutResult, Box<dyn Error>> {
    Ok(layout_from_json(&json::parse(document)?)?)
}
```

- 布局是确定性的：同样的图和选项，在任何平台上都得到逐字节相同的文档。
- **0.01 网格。** 布局文档把坐标舍入到 0.01。布局算出的位置本来就在这个网格上，所以从文档读回来不会变，经过多少个版本都一样。别处来的位置（`300.125`）在 `LayoutResult` 里原样保留，写进文档则是 `300.13`：如果你之后要比较自己的位置，交给 kgdiff 之前先舍入到 0.01。
- 范围总是全部节点，与图的大小无关。

## 下一个版本保持地图

下一个版本到来时，把它与上一个版本做 diff，在上一版的地图上给 **diff** 布局，再把 diff 的位置交给新版本：

```rust
pub fn changes(before: &KGraph, after: &KGraph) -> Result<DiffResult> {
    diff_graphs(before.clone(), after.clone(), DiffOptions::default())
}
```

```rust
pub fn diff_map_first(diff: &DiffResult, previous: &LayoutResult) -> Result<LayoutResult> {
    layout_diff_on(diff, previous, &LayoutOptions::default())
}
```

```rust
pub fn next_map_of(diff: &DiffResult, both: &LayoutResult) -> Result<LayoutResult> {
    layout_after(diff, both, &LayoutOptions::default())
}
```

- `layout_diff_on` 让上一版地图上的每个节点都留在原位，不论它继续存在还是被删除，只安置新增的节点。范围总是全部节点，不论 diff 有多大。
- `layout_after` 不做任何计算：新版本的每个节点就在 diff 里的位置上。结果以新版本的 id 为键，就是要和这个版本一起保存的布局，也是再下一个版本的“上一版地图”。
- diff 的布局以**并集 id** 为键。新版本里的节点，并集 id 就是它自己的 id；被删除的节点用旧版本的 id，如果新版本把这个 id 用在了别的节点上，则在后面加上 `@before`。两个函数都通过并集节点的 `before_id` 和 `after_id` 取位置，所以你不用自己换算 id。

这就是那条承诺的全部内容：从一个版本切到下一个版本，或者从任一版本切到两者的 diff，节点都不动。测试在语料的每个用例上逐位检查它，其中包括合并、拆分和换 id。

位置是**经由 diff** 带过去的，而不是按 id。用 `layout_graph` 加上一版的位置（作为固定位置 `pinned`）给新版本布局是一种简写，但它并不等价：

| 两个版本之间                                          | 经由 diff 带位置 | 按 id 带位置（`pinned: previous.positions.clone()`） |
| ----------------------------------------------------- | ---------------- | ---------------------------------------------------- |
| 节点的 id 不变                                        | 不动             | 不动                                                 |
| 节点换了 id 继续存在（`replaces` 提示、按相似度匹配） | 不动             | 被当成新节点重新安置                                 |
| 一个 id 被另一个节点占用（没有稳定 id 的图）          | 各自留在原位     | 另一个节点被固定在旧节点的位置上                     |

在一致性语料上，按 id 带位置会让每一个换了 id 的节点移动：撰写本文时，29 个用例中有 9 个、共 53 个节点，其中 37 个在一张由语言模型抽取的图里。

**先给 diff 布局**，是为了被删除的节点。新版本自己的布局看不到它们，所以可能把新节点放到它们原来的位置上（撰写本文时语料里有一处：按那种顺序布局，`dataset-data-lineage` 中一个新增节点和一个被删除节点的圆盘重叠 0.16 个世界单位）。在 diff 上，新节点会避开被删除的节点，语料的任何用例里都没有一对重叠。

位置也可以放在你的导出里，即节点的 `position` 成员（[`graph.v1.json`](../../../packages/core/schema/graph.v1.json)）：布局把它当作已知位置，它永远不属于 diff。上一版地图没有安置的节点，`layout_diff_on` 会读它的 `position`；上一版地图优先于它，`options.pinned` 里的固定位置（以并集 id 为键）优先于两者。

## 给两个都有地图的版本的 diff 布局

每个版本存一份布局，diff 就不需要自己的布局。任何时候要展示两个已保存版本的 diff，不论还是刚才那两个，还是相隔更远的两个，每个节点都已经有位置：

```rust
pub fn diff_map(
    diff: &DiffResult,
    before: &LayoutResult,
    after: &LayoutResult,
) -> Result<LayoutResult> {
    let options = LayoutOptions {
        // Pins are keyed by union id, which is its own id for a node of the after version.
        // They win over the before version's positions, which are left for the removed nodes.
        pinned: after.positions.clone(),
        ..LayoutOptions::default()
    };
    layout_diff_on(diff, before, &options)
}
```

新版本里的节点就在新版本的位置上，被删除的节点留在旧版本的位置上，不做任何模拟。

- 对相邻的两个版本，这样得到的位置就是新版本到来时 `layout_diff_on` 给出的位置，所以不必保存 diff 的布局。
- 相隔更远的两个版本之间同样没有节点移动，但一个被删除的节点和一个后来新增的节点从未在同一个画面里一起安置过，可能靠得很近。
- 如果两份导出都用 `position` 带着各自的位置，默认的 `layout_diff`（因而 `report_payload` 和 `kgdiff` 命令行也是）不需要任何固定位置就会把 diff 布局在这些位置上：同样的布局，逐字节相同的报告。这在大图阈值 3000 个节点以内成立；超过之后默认布局只覆盖变化。

## 摘要和报告

`kgdiff-report` 渲染 `kgdiff` 命令打印的内容，但不带它的参数解析和文件读写：终端摘要和 Markdown 摘要（还有 `render_stat`、`render_name_status`），英文或简体中文。

```rust
pub fn summaries(diff: &DiffResult, title: &str) -> Result<(String, String)> {
    let context = TextContext {
        paint: Painter::plain(),
        locale: Locale::En,
        width: 80,
        limit: 50,
        watch: None,
    };
    let text = render_summary(diff, title, &context)?;
    let options = MarkdownOptions {
        locale: Locale::En,
        title,
        generator: "my-app 1.0",
        watch: None,
    };
    let markdown = render_markdown(diff, &options)?;
    Ok((text, markdown))
}
```

报告是一份 `kgdiff.report` 载荷：diff、它的布局，以及报告对自己的描述。`report_payload_with` 接受你已经有的布局，所以报告展示的就是你的地图，也不会再布局一次：

```rust
pub fn report_info(title: &str, before: &str, after: &str) -> ReportInfo {
    let side = |name: &str| ReportSide {
        name: name.to_owned(),
        format: None,
    };
    ReportInfo {
        title: title.to_owned(),
        generator: "my-app 1.0".to_owned(),
        generated_at: None,
        before: side(before),
        after: side(after),
        mode: None,
        scope: None,
        theme: None,
        locale: Locale::En,
        panels: None,
        shapes: None,
    }
}
```

```rust
pub fn report(diff: &DiffResult, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    report_payload_with(diff, ReportLayout::Given(layout), info)
}
```

- 传入的布局会对照 diff 检查，属于另一个 diff 的布局会被拒绝（`invalid-input`）：每个位置都必须属于某个并集节点，范围为 `all` 的布局必须安置每一个并集节点。
- 载荷通过 [`report.v1.json`](../../../packages/core/schema/report.v1.json) 的校验。不要自己手工拼载荷。
- `ReportLayout::Default` 就是 `report_payload` 的行为（默认选项的布局）；`ReportLayout::None` 把布局留给浏览器。

要生成读者可以离线打开的单个文件，`build_report_html_with` 会把载荷和查看器内联进去：

```rust
pub fn report_page(
    diff: &DiffResult,
    layout: &LayoutResult,
    info: &ReportInfo,
    viewer: ViewerBundles<'_>,
) -> Result<String> {
    build_report_html_with(diff, ReportLayout::Given(layout), info, viewer)
}
```

`kgdiff-report` 启用特性 `embed-viewer` 构建时，`embedded_viewer()` 返回查看器的脚本；否则传入 `@kgdiff/viewer` 的独立脚本（`dist/standalone/kgdiff-viewer.js`，以及 `kgdiff-viewer-compute.js`，带完整布局的报告不会内联后者）。

单独一个版本也用同样的方式送到浏览器：这张图与它自己的 diff，加上这张图的布局：

```rust
pub fn graph_payload(graph: &KGraph, layout: &LayoutResult, info: &ReportInfo) -> Result<Value> {
    let options = DiffOptions {
        edge_identity: graph.edge_identity(),
        ..DiffOptions::default()
    };
    let unchanged = diff_graphs(graph.clone(), graph.clone(), options)?;
    report_payload_with(&unchanged, ReportLayout::Given(layout), info)
}
```

## 浏览器一侧

### 把载荷交给查看器

```html
<kgdiff-viewer theme="auto" style="height: 640px"></kgdiff-viewer>

<script type="module">
  import "@kgdiff/viewer";

  const viewer = document.querySelector("kgdiff-viewer");
  viewer.payload = await (await fetch("/changes/42/report.json")).json();
</script>
```

带完整布局的载荷打开时什么都不用计算：diff 引擎和布局都不会进入页面。元素本身、它的面板、事件以及组成它的各个元素，见[嵌入查看器](./viewer.md)。

要区分节点的种类，在 `ReportInfo` 里设置 `shapes`：类型和形状，按顺序给出。

```text
shapes: Some(vec![
    ("Concept".to_owned(), "hexagon".to_owned()),
    ("Metric".to_owned(), "diamond".to_owned()),
    ("Table".to_owned(), "square".to_owned()),
]),
```

一个节点取第一个它拥有的类型对应的形状，没有命中就是圆。形状有 `circle`、`square`、`diamond` 和 `hexagon`，差异视图和没有变化的图都一样，已存的布局仍然有效：每种形状都落在布局预留的盒子内。这个字段在载荷里是 `view.shapes`，在 1.0 之前是实验性的。

### 或者自己画

要做自己的界面，就从载荷里读出 diff 和布局，构建场景，把它的帧交给渲染器：

```ts
import { diffFromJSON, unpackDiffJSON } from '@kgdiff/core';
import { layoutFromJSON } from '@kgdiff/layout';
import { createRenderer } from '@kgdiff/renderer';
import { buildScene, createViewState, createVisualResolver, getTheme } from '@kgdiff/scene';

const payload = await (await fetch('/changes/42/report.json')).json();
const result = diffFromJSON(unpackDiffJSON(payload.diff)); // kgdiff-report 写出的 diff 是压缩形式
const layout = layoutFromJSON(payload.layout);

const scene = buildScene(result, layout, { theme: 'light' });
const resolver = createVisualResolver(scene);
const container = document.getElementById('graph') as HTMLElement; // 要有尺寸
const renderer = createRenderer(container, { theme: getTheme('light') });
renderer.setFrame(resolver.resolve(createViewState()));
```

同样的代码也能用 `graph_payload` 的载荷单独画一个版本：没有变化的 diff 用中性色绘制，位置就是这个版本的 diff 将要使用的位置。（`<kgdiff-viewer>` 会把这样的载荷显示成“没有差异”的卡片，见[下文](#还没有的东西)。）选择、回放、滑动对比和小地图见 [scene](../../../packages/scene/README.md) 和 [renderer](../../../packages/renderer/README.md) 的 README（英文）。

### 画自己的标记：图层

只有你的应用才知道的东西（业务域背后的底色、认证标记、节点上的计数），由你画在渲染器的画布上，在图的下面或上面，用你已经有的位置：

```ts
// 在图的下面：背景和点阵之后，其他一切之前。
renderer.addLayer({
  order: 'under',
  draw(ctx, view) {
    const k = view.camera.k;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.10)'; // 颜色要淡，原因见下
    for (const domain of domains) {
      const corner = view.worldToScreen(domain); // 世界坐标下的 { x, y, width, height }
      ctx.beginPath();
      ctx.roundRect(corner.x, corner.y, domain.width * k, domain.height * k, 12);
      ctx.fill();
    }
  },
});

// 在图的上面：标签之后。
const removeMarks = renderer.addLayer({
  order: 'over',
  draw(ctx, view) {
    ctx.fillStyle = '#16a34a';
    for (const id of certified) {
      const position = layout.positions.get(id);
      if (!position) continue;
      const p = view.worldToScreen(position);
      ctx.beginPath();
      ctx.arc(p.x + 8, p.y - 8, 4, 0, Math.PI * 2); // 任何缩放下都是 4 px
      ctx.fill();
    }
  },
});
```

- 图层用 CSS 像素绘制：位置用 `view.worldToScreen` 换算，需要随缩放变大的尺寸乘以 `view.camera.k`。它随每一帧绘制，滑动对比时每一侧各画一次并裁剪到该侧，也包含在 `toDataURL` 里。你自己的数据变了就调用 `renderer.requestRender()`；调用 `addLayer` 返回的函数可以移除图层。
- 图层不参与拾取，其中的文字也不参与标签的避让。用 `renderer.camera.screenToWorld` 和 `click` 事件的 `world` 给自己的标记做命中检测。
- **已知限制：有色底上的标签描边。** 标签带一圈画布背景色的描边，叠在 `under` 图层染过色的区域上时，会显出一道淡淡的轮廓。颜色淡一些（约 10% 的不透明度，如主题里的 `soft` 颜色）就看不出来。
- 在查看器里，`<kgdiff-stage>` 有同样的方法（`stage.addLayer(…)`），所以变更图上也能带着你在自己的图页面上画的标记。

完整的规则见[渲染器的 README](../../../packages/renderer/README.md#layers-drawing-under-and-over-the-graph)（英文）。

## 还没有的东西

[RFC 0003](https://github.com/iiwish/kgdiff/blob/main/docs/rfcs/0003-embedding-hosts.md)（英文）还规划了两个部分。它们现在都不存在，而且这份 RFC 还是草案：版本和细节都可能变化。

| 部分 | 内容                                             | 计划版本          | 在此之前                                                                                      |
| ---- | ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------- |
| 4c   | 朴素视图：在查看器里看单张图，按你的类别着色     | 0.10，或 1.0 之后 | 场景和渲染器用中性色画没有变化的 diff；`<kgdiff-viewer>` 显示“没有差异”卡片；着色通过图层完成 |
| 4d   | 分组：每组一块背景，以及让同组节点靠在一起的布局 | 1.0 之后          | 根据位置在 `under` 图层上画背景；布局不知道分组                                               |

同样还没有的：TypeScript 里的 `layout_graph`、`layout_diff_on` 和 `layout_after`。`@kgdiff/layout` 没有与它们对应的函数；`layoutGraph` 计划随布局的其余部分一起放进 `@kgdiff/compute`。在浏览器里可以给一张图与它自己的 diff 布局；更好的做法是像上面那样在服务端计算布局。
