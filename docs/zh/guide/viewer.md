# 嵌入查看器

`<kgdiff-viewer>` 是一个 Web 组件：一个自定义元素，可以配合任何框架使用，也可以不用框架。它和 HTML 报告、Playground 里的查看器是同一个。

![kgdiff 查看器：两个版本画在同一张图上，变化按类别着色，右侧是待审阅的变更列表](../../images/viewer-zh.webp)

## 安装

```sh
npm install @kgdiff/viewer
```

这个包只提供 ESM，可在主流现代浏览器中运行。

## 显示一份 diff

```html
<kgdiff-viewer theme="auto" style="height: 640px"></kgdiff-viewer>

<script type="module">
  import '@kgdiff/viewer'; // 定义 <kgdiff-viewer>

  const viewer = document.querySelector('kgdiff-viewer');
  const text = async (url) => (await fetch(url)).text();
  await viewer.load({
    before: { text: await text('/graphs/v1.ttl'), filename: 'v1.ttl' },
    after: { text: await text('/graphs/v2.ttl'), filename: 'v2.ttl' },
  });
</script>
```

记得给元素设置高度。`load()` 的每一侧可以是：

- `{ text, filename }`：用 `@kgdiff/formats` 解析，格式根据文件名和内容判断；`parse` 用来传解析选项；
- [kgdiff JSON](../formats.md#kgdiff-json) 形式的图对象 `{ nodes, edges }`；
- `@kgdiff/core` 规范化后的图。

另外还可以传 `diff`，即 [diff 选项](./library.md#选项)（匹配方式、层级谓词、忽略的属性），传 `names` 给两侧命名，传 `title` 设置标题。解析器、diff 引擎和布局都是按需加载的，不会进入你的首屏包。

## 监听与控制

```js
viewer.addEventListener('kgdiff-ready', (event) => console.log(event.detail.stats));
viewer.addEventListener('kgdiff-select', (event) => console.log(event.detail.hunk));

viewer.next(); // 选中下一个变化
viewer.mode = 'replay';
viewer.play();
```

每个 HTML 属性、JavaScript 属性、方法和事件，连同取值和默认值，都列在由源码生成的
[查看器元素：参考](../viewer-elements.md#kgdiff-viewer)里。页面最常设置的是：`mode`（`overlay`、`swipe`、`replay`）、`scope`（`changes`：只看变更，可配合任意对比方式）、`theme`、`locale`、`panels`（[见下文](#调整布局)）和 `chrome`（`none` 用于[小块嵌入](#嵌入一段循环回放)）。事件会冒泡出查看器，并且在每个元素、document 和 window 上都有类型（`KgdiffEventMap`）。

`changes` 是 scope，不是 mode。加入 `scope` 之前表示“只看变更”的 `mode="changes"` 现在是未知值，按默认的 `overlay` 处理；请改写成 `mode="overlay" scope="changes"`。

## 调整布局

查看器的每个区域都可以用一个属性设为展开、收起（收起到能再次展开它的控件）或隐藏：变更列表（`list`）、详情面板（`detail`）、搜索（`search`）、筛选（`filters`）、视图坞（`dock`）、回放控制条（`transport`）、图例（`legend`）、缩放按钮（`zoom`）、小地图（`minimap`）、标题（`title`）和操作按钮（`actions`）。查看器会记住读者的调整（面板、侧栏宽度、列表与详情之间的分隔位置、主题、配色、语言），下次访问时恢复；你的页面设置的值优先于这些记录。`persist="none"` 关闭记住，`persist-key="my-app:viewer"` 让你的应用的记录与同一个源上的其他应用分开。规则见[面板](../interaction.md#panels)。

### 默认收起详情面板

```html
<kgdiff-viewer panels="detail:collapsed" style="height: 640px"></kgdiff-viewer>
```

变更列表占满侧栏的高度；读者点详情栏即可展开。也可以用 JavaScript 属性设置：`viewer.panels = { detail: 'collapsed' }`。读取 `panels` 得到你的页面声明的内容；`viewer.layout.panels` 给出每个区域当前的状态，包括读者的改动。再次设置同样的 `panels`（React 或 Vue 重新渲染时）会保留读者的改动。

### 只看回放

```html
<kgdiff-viewer
  mode="replay"
  panels="list:hidden detail:hidden search:hidden filters:hidden"
  style="height: 480px"
></kgdiff-viewer>
```

画布占满整个宽度，保留视图坞和回放控制条。再加上 `dock:hidden zoom:hidden minimap:hidden` 只留控制条；完全不要控件时，用 `chrome="none" loop`（[见下文](#嵌入一段循环回放)）。用元素组合时，同样的效果只需一个根元素和一块画布：`<kgdiff-root mode="replay"><kgdiff-stage panels="zoom:hidden minimap:hidden"></kgdiff-stage></kgdiff-root>`。

### 响应布局变化

```js
viewer.addEventListener('kgdiff-layout', (event) => {
  const { panels, sidebarWidth, source } = event.detail;
  if (source === 'user') saveLayout({ panels, sidebarWidth }); // 例如按用户保存到你的服务器
});
```

### 把你的内容放在画布上

画布有五个插槽可以放你页面的内容：`top-start` 和 `top-end`（在显示着的标题和操作按钮下方）、`bottom-start`、`bottom-center` 和 `bottom-end`。每次适应视图和飞行定位时，图都会避开放在那里的内容来取景。

```html
<kgdiff-viewer style="height: 640px">
  <my-status-card slot="top-end"></my-status-card>
</kgdiff-viewer>
```

放进插槽的界面元素会替换内置的那个区域，例如用 `<kgdiff-legend slot="bottom-start" variant="mini">` 代替图例卡片，或者用 `<kgdiff-title slot="top-start">` 和 `<kgdiff-actions slot="top-end">` 代替标题和操作按钮，它们就放在原来的位置（[见下文](#自己组合布局)）；`panels` 对其余区域照常生效。查看器较窄时的紧凑布局里，`top-end` 的内容移到缩放按钮下方，底部的内容移到视图坞上方：那里空间不多，内容要小。

## 嵌入一段循环回放

要在别的页面上用一小块区域展示图的变化，可以去掉审阅界面，让回放循环播放：

```html
<kgdiff-viewer mode="replay" chrome="none" loop style="height: 320px"></kgdiff-viewer>
```

`chrome="none"` 只留下图、鼠标悬停时的提示和一行图例；标题、操作按钮、视图坞（连同步骤说明和播放条）、变化列表、缩放按钮和小地图都不显示，点击和快捷键不起作用，视野始终连同节点名称一起完整放进画布，不会有名字被画布边缘切掉。`loop` 让回放一轮接一轮地播放，每轮之间停 `loop-delay` 毫秒（默认 1.2 秒），鼠标停在图上时也会暂停。每轮播完都会触发 `kgdiff-replay-end`。

## 自己组合布局

查看器由一些元素组成，这些元素你也可以自己摆放（在 0.6 中是实验性的，0.7 起稳定：在此之前可能在次版本中变化）。`<kgdiff-root>` 持有 diff 会话，本身不显示任何东西；其他元素无论放在哪里都显示它的一部分：放在它里面，或者用 `for="<根元素 id>"` 放在页面任意位置。

| 元素                     | 显示                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `<kgdiff-root>`          | 不显示：拥有查看器的属性、方法和事件                          |
| `<kgdiff-stage>`         | 图，以及它自己的视图坞、控制条、图例、缩放按钮和小地图        |
| `<kgdiff-change-list>`   | 变更列表和审阅进度                                            |
| `<kgdiff-change-detail>` | 选中的变更                                                    |
| `<kgdiff-search>`        | 节点搜索，结果在弹出层里                                      |
| `<kgdiff-filters>`       | 筛选标签                                                      |
| `<kgdiff-view-dock>`     | 视图坞：对比方式、仅看变更和上下文跳数                        |
| `<kgdiff-transport>`     | 回放控制条，只在回放模式下显示                                |
| `<kgdiff-legend>`        | 图例：卡片（`open` 反映它是否展开）或一行（`variant="mini"`） |
| `<kgdiff-zoom>`          | 放大、缩小和适应视图，作用于一块画布                          |
| `<kgdiff-minimap>`       | 一块画布的小地图（整张图都在视野内时为 `:state(overview)`）   |
| `<kgdiff-title>`         | 品牌标识和对比的两个版本名                                    |
| `<kgdiff-actions>`       | 外观菜单（主题、配色、语言）和快捷键对话框                    |

### 把变更列表放进你自己的侧栏

```html
<div class="app">
  <aside class="my-sidebar">
    <kgdiff-search for="diff"></kgdiff-search>
    <kgdiff-change-list for="diff"></kgdiff-change-list>
  </aside>
  <kgdiff-root id="diff">
    <kgdiff-stage>
      <my-legend-card slot="top-end"></my-legend-card>
    </kgdiff-stage>
  </kgdiff-root>
  <kgdiff-change-detail for="diff" class="my-drawer"></kgdiff-change-detail>
</div>

<script type="module">
  import '@kgdiff/viewer'; // 或者只引入用到的：'@kgdiff/viewer/elements/root'、…/stage 等
  await document.getElementById('diff').load({ before, after });
</script>
```

- 用你自己的 CSS 布局这些元素；给画布和列表一个高度。`<kgdiff-root>` 以 `display: contents` 渲染，它的子元素直接参与你的布局。
- 画布的插槽（`top-start`、`top-end`、`bottom-start`、`bottom-center`、`bottom-end`）把你的内容放在画布上，图会避开它来取景。放进插槽的界面元素（视图坞、控制条、图例、缩放按钮或小地图）替换画布自己的那个，画布的 `panels` 对其余区域照常生效。
- 放在其他任何地方的元素，无论是否盖在画布上，适应视图和飞行定位都不会避开它，除非你登记它：`stage.registerObstacle(element)`。
- 要在画布本身上画东西，画在图的下面或上面（一组节点背后的底色、节点上你自己的标记），给画布加一个图层：`stage.addLayer({ order: 'under', draw(ctx, view) { … } })`。它随每一帧绘制，用 CSS 像素（`view.worldToScreen` 换算布局里的位置），也会出现在导出的 PNG 里；规则见[渲染器的 README](../../../packages/renderer/README.md#layers-drawing-under-and-over-the-graph)。0.9 中为实验性。
- `<kgdiff-zoom>` 和 `<kgdiff-minimap>` 作用于一块画布：离它最近的外层画布，或者 `stage="<id>"` 指定的页面上任意一块（`zoom.stage`，找到的画布是 `zoom.stageElement`）。放在 `<kgdiff-viewer>` 里时，它们作用于查看器的画布。其他元素和变更列表一样显示根元素的会话。
- 你自己放置的小地图在整张图都在视野内时仍然显示，你的布局不会跳动；用 `kgdiff-minimap:state(overview) { visibility: hidden }` 让它原地隐藏。放进画布的插槽时，它会像画布自己的小地图一样在这时隐藏。
- 键盘映射属于根元素：`j` / `k`、`x`、`/` 等在绑定到它的每个元素里都有效，`/` 聚焦搜索，`?` 打开 `<kgdiff-actions>` 的快捷键对话框，对话框列出 `keymap` 生效后实际绑定的按键。`shortcuts` 和 `keymap` 设在根元素上。`+`、`−` 和 `f` 键缩放、适应根元素的每一块画布。
- 组合出来的元素什么也不记：布局归你的页面所有。
- 每个元素都有只定义它自己的子路径：`@kgdiff/viewer/elements/root`、`/stage`、`/change-list`、`/change-detail`、`/search`、`/filters`、`/view-dock`、`/transport`、`/legend`、`/zoom`、`/minimap`、`/title`、`/actions`。

### 前后两版并排对比

```html
<kgdiff-root id="diff">
  <div class="pair">
    <kgdiff-stage version="before" panels="dock:hidden transport:hidden"></kgdiff-stage>
    <kgdiff-stage version="after" panels="dock:hidden transport:hidden legend:hidden"></kgdiff-stage>
  </div>
  <kgdiff-change-list></kgdiff-change-list>
</kgdiff-root>

<style>
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; height: 480px; }
  kgdiff-change-list { display: block; height: 240px; }
</style>
```

一个根元素，两块画布：无论什么模式，每块只画一个版本（`version="before"`、`version="after"`，并有一个标签写明版本），各有自己的相机、缩放按钮和小地图。选中、悬停、筛选和搜索属于根元素：在列表里选一项变更（或按 `j`），两块画布都会把它带进视野，各自按自己的版本取景；在一块画布上悬停的节点，两块里都会高亮。需要“仅看变更”时加上 `<kgdiff-view-dock>`，也可以在两块画布上方放 `<kgdiff-title>` 和 `<kgdiff-actions>`。

### 只用画布和控制条的回放

```html
<kgdiff-root mode="replay" loop>
  <kgdiff-stage panels="dock:hidden transport:hidden legend:hidden" style="height: 360px">
  </kgdiff-stage>
  <kgdiff-transport></kgdiff-transport>
</kgdiff-root>
```

控制条放在画布下方而不是盖在上面，用来播放、单步和拖动根元素的回放；它只在回放模式下显示。如果把它放进画布的插槽 `<kgdiff-transport slot="bottom-center">`，它会替换画布自己的控制条，浮在画布上，图会避开它（保留 `dock:hidden`）。

## 用 CSS 定制主题

颜色和字体是 CSS 自定义属性，设在 `<kgdiff-viewer>`（或 `<kgdiff-root>`）上，画布和每个面板都继承它们。用普通 CSS 覆盖即可：

```css
kgdiff-viewer {
  --kgdiff-accent: #e8590c;
  --kgdiff-accent-soft: rgb(232 89 12 / 0.16);
  --kgdiff-font: "IBM Plex Sans", system-ui, sans-serif;
}
```

[令牌列表](../../visual-language.md#css-tokens)（英文）从 0.6 起是公开 API。浅色、深色和色盲友好配色仍在底层可用（`theme`、`palette`）；你的值优先于它们，保证可读性由你负责。令牌以查看器无法察觉的方式变化时（祖先元素上的类、之后加载的样式表），调用 `viewer.refreshTheme()`，让画布跟着变。

## 保存审阅进度

查看器会在浏览器里记住哪些变化已标记为已审阅。要把进度存到别处，比如你的后端，可以监听 `kgdiff-review`，再用 `setReviewed()` 恢复：

```js
viewer.addEventListener('kgdiff-review', (event) => save(event.detail.progress.reviewed));
viewer.addEventListener('kgdiff-ready', async () => {
  for (const id of await loadSaved()) viewer.setReviewed(id, true);
});
```

这些 id 是变更组的 id，只对一对版本有效。请按这一对版本保存；要把进度带到更新的版本上，先读 [Hunk ids](../../algorithms.md#hunk-ids)（英文）：同一个 id 表示图中的同一处，不表示内容相同。

## 编辑器支持

`@kgdiff/viewer` 附带一份
[Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest)（`custom-elements.json`，由包的 `customElements` 字段指明）供工具读取，以及由它生成的两个文件，和[参考页](../viewer-elements.md)一样：

- **VS Code** 借助包里的自定义数据，在 HTML 中补全并说明这些元素和它们的属性。在项目的 `.vscode/settings.json` 中：

  ```json
  { "html.customData": ["./node_modules/@kgdiff/viewer/vscode.html-custom-data.json"] }
  ```

- **React 19 + TypeScript** 可以在 JSX 中为这些元素、它们的属性和事件提供类型（与元素一样是实验性的）：在项目中任意位置导入一次类型即可。

  ```ts
  import type {} from '@kgdiff/viewer/react';
  ```

## React

React 19 渲染自定义元素时会使用它们的属性：元素拥有的属性（`panels`、`keymap`、`mode` 等）按 JavaScript 属性设置，对象也一样；其余按 HTML 属性设置。渲染之前先导入 `@kgdiff/viewer`，这样 React 设置属性时元素已经定义好了。使用 TypeScript 时，`@kgdiff/viewer/react` 为它们提供类型（[编辑器支持](#编辑器支持)）。

```tsx
import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement } from '@kgdiff/viewer';
import type {} from '@kgdiff/viewer/react';
import { useEffect, useRef } from 'react';

interface Props {
  readonly before: GraphSource;
  readonly after: GraphSource;
  readonly onSelect: (hunk: string | null) => void;
}

export function GraphDiff({ before, after, onSelect }: Props) {
  const viewer = useRef<KgdiffViewerElement>(null);

  useEffect(() => {
    void viewer.current?.load({ before, after });
  }, [before, after]);

  return (
    <kgdiff-viewer
      ref={viewer}
      theme="auto"
      panels={{ detail: 'collapsed' }}
      keymap={{ x: null, r: 'review' }}
      onkgdiff-select={(event) => onSelect(event.detail.hunk)}
      style={{ height: 640 }}
    />
  );
}
```

- `onkgdiff-select` 监听 `kgdiff-select`：元素没有对应属性的 `on…` 属性，React 19 会为它添加事件监听。`event.detail` 有类型。
- 方法通过 ref 调用：`viewer.current?.next()`。
- `panels` 的对象字面量每次渲染都是一个新对象，这没有关系：查看器比较的是页面声明的内容，所以重新渲染时声明同样的面板，会保留读者展开或收起的状态；只有声明变了的区域才会让位。
- React 18 把所有属性都按 HTML 属性设置：请使用文本写法（`panels="detail:collapsed"`、`keymap="x:none r:review"`），并在 ref 上用 `addEventListener` 监听事件。

## Vue

在 `vite.config.js` 中告诉 Vue，`kgdiff-*` 标签是自定义元素：

```js
import vue from '@vitejs/plugin-vue';

export default {
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('kgdiff-') } } }),
  ],
};
```

然后像普通元素一样使用：

```vue
<script setup lang="ts">
import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement, ViewerPanels } from '@kgdiff/viewer';
import { onMounted, ref } from 'vue';

const props = defineProps<{ before: GraphSource; after: GraphSource }>();
const emit = defineEmits<{ select: [hunk: string | null] }>();
const viewer = ref<KgdiffViewerElement | null>(null);
const panels: ViewerPanels = { detail: 'collapsed' };

onMounted(() => viewer.value?.load({ before: props.before, after: props.after }));
const onSelect = (event: CustomEvent<{ hunk: string | null }>) => emit('select', event.detail.hunk);
</script>

<template>
  <kgdiff-viewer
    ref="viewer"
    theme="auto"
    :panels.prop="panels"
    :keymap.prop="{ x: null, r: 'review' }"
    style="height: 640px"
    @kgdiff-select="onSelect"
  />
</template>
```

- `.prop` 把 `panels` 和 `keymap` 作为 JavaScript 属性（对象）绑定；元素拥有该属性时 Vue 本来也会这样绑定，`.prop` 确保在元素定义之前也是如此。
- `@kgdiff-select` 监听事件。Vue 不知道元素的事件，所以由处理函数自己给 `event` 标注类型。
- 模板 ref 拿到元素，用来调用它的方法。

## Svelte

Svelte 5 设置自定义元素的属性时，元素拥有该属性就按 JavaScript 属性设置（对象也一样），否则按 HTML 属性设置；`onkgdiff-select` 监听事件，`bind:this` 拿到元素。

```svelte
<script lang="ts">
import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement, ViewerPanels } from '@kgdiff/viewer';

interface Props {
  before: GraphSource;
  after: GraphSource;
  onselect: (hunk: string | null) => void;
}

let { before, after, onselect }: Props = $props();
let viewer = $state<KgdiffViewerElement>();
const panels: ViewerPanels = { detail: 'collapsed' };

$effect(() => {
  void viewer?.load({ before, after });
});
</script>

<kgdiff-viewer
  bind:this={viewer}
  theme="auto"
  {panels}
  keymap={{ x: null, r: 'review' }}
  style="height: 640px"
  onkgdiff-select={(event: CustomEvent<{ hunk: string | null }>) => onselect(event.detail.hunk)}
></kgdiff-viewer>
```

## 不用打包工具

`@kgdiff/viewer/standalone`（`dist/standalone/kgdiff-viewer.js`）是一个普通脚本，它定义这个元素并显示预先计算好的 diff，命令行生成的 HTML 报告里嵌的就是它。加上计算插件 `@kgdiff/viewer/standalone/compute`（`kgdiff-viewer-compute.js`）后，它还能用 `load()` 加载图对象（`{ nodes, edges }`），并显示没有布局的数据，读到时给它布局（没有计算插件时，这样的数据会显示一条说明原因的错误）。要在浏览器里解析文本，需要使用 ESM 包并配合打包工具。

## 大图

对于大图，查看器打开时会开启“仅看变更”，只为变化及其周边布局，而不是整张图。在浏览器里计算一份大 diff 及其布局需要时间；命令行生成的 HTML 报告提前完成了这些工作，所以打开就能看。
