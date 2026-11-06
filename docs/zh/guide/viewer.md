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

| 属性               | 取值                                                    | 默认                      |
| ------------------ | ------------------------------------------------------- | ------------------------- |
| `mode`             | `overlay`、`swipe`、`replay`（旧值 `changes` 见下文）   | `overlay`                 |
| `scope`            | `all`、`changes`：只看变更，可配合任意对比方式          | `all`（大图为 `changes`） |
| `theme`            | `auto`、`light`、`dark`                                 | `auto`                    |
| `palette`          | `default`、`colorblind`                                 | `default`                 |
| `locale`           | `en`、`zh-CN`                                           | 取自 `navigator.language` |
| `panels`           | 各区域的状态，例如 `detail:collapsed minimap:hidden`    | 全部展开，图例收起        |
| `persist`          | `none`：什么也不记                                      | 记住（按源）              |
| `persist-key`      | 记住时使用的 `localStorage` 键                          | `kgdiff:viewer`           |
| `sidebar`          | `open`、`closed`（`panels` 的一个预设）                 |                           |
| `sync-hash`        | 布尔值：深链接 `#kgdiff=hunk:<id>;mode:<m>;scope:<s>`   |                           |
| `shortcuts`        | `scoped`、`global`（页面上没有焦点时也生效）、`none`    | `scoped`                  |
| `global-shortcuts` | 布尔值：等同于 `shortcuts="global"`                     |                           |
| `keymap`           | 重新绑定或解除按键，例如 `x:none r:review`              |                           |
| `header`           | `compact`：不显示品牌和图名，适合页面自己显示这些信息时 |                           |
| `chrome`           | `none`：只显示图本身，适合嵌入小块区域                  | `full`                    |
| `legend`           | `auto`、`full`、`mini`（一行）、`none`                  | `auto`                    |
| `loop`             | 布尔值：回放自动播放、循环往复                          |                           |
| `loop-delay`       | 循环回放播完到重新开始之间的毫秒数                      | `1200`                    |
| `pause-on-hover`   | `false`：鼠标停在图上时循环回放也不暂停                 | 暂停                      |

加入 `scope` 之前的写法 `mode="changes"` 仍然有效：它表示 `overlay` 加 `scope="changes"`，属性会被改写成这两个值。

`mode`、`scope`、`theme`、`palette`、`locale`、`panels`、`persist`、`chrome`、`legend`、`loop`、`loopDelay`、`pauseOnHover`、`shortcuts` 和 `keymap` 同时也是 JavaScript 属性（`panels` 和 `keymap` 也接受对象）。方法：`load()`、`selectHunk(id)`、`next()`、`prev()`、`play()`、`pause()`、`fit({ animate, padding })`、`exportDelta()`、`reviewState()`、`setReviewed(id, reviewed)` 和 `refreshTheme()`。事件都会冒泡并穿过 Shadow DOM：`kgdiff-ready` `{ stats }`、`kgdiff-select` `{ hunk, node }`、`kgdiff-mode` `{ mode, scope }`、`kgdiff-review` `{ hunk, reviewed, progress }`、`kgdiff-error` `{ error }`、`kgdiff-replay-end` `{ loop }` 和 `kgdiff-layout` `{ panels, sidebarWidth, detailShare, source }`。详见[查看器：交互与 API](../interaction.md#嵌入-api)。

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

## 嵌入一段循环回放

要在别的页面上用一小块区域展示图的变化，可以去掉审阅界面，让回放循环播放：

```html
<kgdiff-viewer mode="replay" chrome="none" loop style="height: 320px"></kgdiff-viewer>
```

`chrome="none"` 只留下图、鼠标悬停时的提示和一行图例；标题、操作按钮、视图坞（连同步骤说明和播放条）、变化列表、缩放按钮和小地图都不显示，点击和快捷键不起作用，视野始终连同节点名称一起完整放进画布，不会有名字被画布边缘切掉。`loop` 让回放一轮接一轮地播放，每轮之间停 `loop-delay` 毫秒（默认 1.2 秒），鼠标停在图上时也会暂停。每轮播完都会触发 `kgdiff-replay-end`。

## 自己组合布局

查看器由一些元素组成，这些元素你也可以自己摆放（在 0.6 中是实验性的：稳定之前可能在次版本中变化）。`<kgdiff-root>` 持有 diff 会话，本身不显示任何东西；其他元素无论放在哪里都显示它的一部分：放在它里面，或者用 `for="<根元素 id>"` 放在页面任意位置。

| 元素                     | 显示                                 |
| ------------------------ | ------------------------------------ |
| `<kgdiff-root>`          | 不显示：拥有查看器的属性、方法和事件 |
| `<kgdiff-stage>`         | 图，以及视图坞、控制条、图例和缩放   |
| `<kgdiff-change-list>`   | 变更列表和审阅进度                   |
| `<kgdiff-change-detail>` | 选中的变更                           |
| `<kgdiff-search>`        | 节点搜索，结果在弹出层里             |
| `<kgdiff-filters>`       | 筛选标签                             |

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
- 画布的插槽（`top-start`、`top-end`、`bottom-start`、`bottom-center`、`bottom-end`）把你的内容放在画布上，图会避开它来取景。你自己定位的内容，调用 `stage.registerObstacle(element)`。
- 键盘映射属于根元素：`j` / `k`、`x`、`/` 等在绑定到它的每个元素里都有效，`/` 聚焦搜索。`shortcuts` 和 `keymap` 设在根元素上。
- 组合出来的元素什么也不记：布局归你的页面所有。
- 每个元素都有只定义它自己的子路径：`@kgdiff/viewer/elements/root`、`/stage`、`/change-list`、`/change-detail`、`/search`、`/filters`。`@kgdiff/viewer/session` 是不带任何元素的无界面会话。

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

## React

用 ref 调用 `load()` 并监听事件：

```jsx
import '@kgdiff/viewer';
import { useEffect, useRef } from 'react';

export function GraphDiff({ before, after, onSelect }) {
  const viewer = useRef(null);

  useEffect(() => {
    viewer.current.load({ before, after });
  }, [before, after]);

  useEffect(() => {
    const element = viewer.current;
    const listener = (event) => onSelect(event.detail.hunk);
    element.addEventListener('kgdiff-select', listener);
    return () => element.removeEventListener('kgdiff-select', listener);
  }, [onSelect]);

  return <kgdiff-viewer ref={viewer} theme="auto" style={{ height: 640 }} />;
}
```

在 TypeScript 中，需要在 `JSX.IntrinsicElements` 里声明 `kgdiff-viewer`；包里导出了这个元素的类型 `KgdiffViewerElement`。

`kgdiff-*` 事件已加入 TypeScript 的全局事件映射（`KgdiffEventMap`），所以在任何元素、document 或 window 上监听，`detail` 都有类型，不需要类型断言：`viewer.addEventListener('kgdiff-select', (event) => event.detail.hunk)`。

## Vue

先在 `vite.config.js` 里告诉 Vue，`kgdiff-*` 标签是自定义元素：

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
<script setup>
import '@kgdiff/viewer';
import { onMounted, ref } from 'vue';

const props = defineProps(['before', 'after']);
const emit = defineEmits(['select']);
const viewer = ref(null);

onMounted(() => viewer.value.load({ before: props.before, after: props.after }));
const onSelect = (event) => emit('select', event.detail.hunk);
</script>

<template>
  <kgdiff-viewer ref="viewer" theme="auto" style="height: 640px" @kgdiff-select="onSelect" />
</template>
```

## 不用打包工具

`@kgdiff/viewer/standalone`（`dist/standalone/kgdiff-viewer.js`）是一个普通脚本，它定义这个元素并显示预先计算好的 diff，命令行生成的 HTML 报告里嵌的就是它。加上计算插件 `@kgdiff/viewer/standalone/compute`（`kgdiff-viewer-compute.js`）后，它还能用 `load()` 加载图对象（`{ nodes, edges }`）。要在浏览器里解析文本，需要使用 ESM 包并配合打包工具。

## 大图

对于大图，查看器打开时会开启“仅看变更”，只为变化及其周边布局，而不是整张图。在浏览器里计算一份大 diff 及其布局需要时间；命令行生成的 HTML 报告提前完成了这些工作，所以打开就能看。
