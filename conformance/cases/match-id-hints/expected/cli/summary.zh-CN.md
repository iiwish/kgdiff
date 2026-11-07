## kgdiff · retail skeleton → enriched

**11 组共 28 处变化** · 节点 14 · 关系 14

| | 新增 | 删除 | 修改 | 未变 | 变更前 → 变更后 |
| :-- | --: | --: | --: | --: | --: |
| **节点** | 4 | 4 | 7 | 3 | 14 → 14 |
| **关系** | 3 | 3 | 7 | 4 | 14 → 14 |

🟩 新增 · 🟥 删除 · 🟨 内容（改名、属性、类型、别名） · 🟦 结构（移动、关系） · 🟪 身份（合并、拆分、换 ID）

<details open>
<summary>⚑ 优先审查 (1)</summary>

*这些变更修改了受关注的属性（定义）。这类修改在差异里看起来很小，却可能改变已有数据的含义。*

- 🟨 \~ 「Revenue」改名为「Net revenue」 — *⚑ 定义 · 属性 +1 \~1*

</details>

<details open>
<summary>删除 (1)</summary>

- 🟥 − 删除「GMV」及 1 条关系 — *类型 Metric · 原关联「Order」*

</details>

<details open>
<summary>结构调整 (3)</summary>

- 🟦 ⇄ 「Channel」移至「Business taxonomy」下 — *原属「Geography」*
- 🟪 ⑂ 「SKU」（dim\_sku）拆分为「Bundle」和「SKU」（sku） — *依据替代声明 · 迁移 2 条关系 · 关系 +1*
- 🟪 ⊕ 「Client」和「Customer」（dim\_customer）合并入「Customer」（customer） — *依据替代声明 · 迁移 3 条关系 · 合并 1 条重复关系*

</details>

<details open>
<summary>修改 (6)</summary>

- 🟨 \~ 弃用「Region」 — *由「Sales region」替代 · 关系 −1*
- 🟨 \~ 「Category」的 ID 已变更 — *ID dim\_category → category · 替代「Category」*
- 🟨 \~ 「Revenue」改名为「Net revenue」 — *⚑ 定义 · 属性 +1 \~1*
- 🟨 \~ 「Order line」的 ID 已变更 — *ID fct\_order\_line → order\_line · 替代「Order line」*
- 🟨 \~ 「Product」的 ID 已变更 — *ID dim\_product → product · 替代「Product」*
- 🟨 \~ 「Order」的 ID 已变更 — *ID fct\_order → order · 替代「Order」 · 关系 +1 \~1*

</details>

<details open>
<summary>新增 (1)</summary>

- 🟩 + 新增「Sales region」及 1 条关系 — *类型 Entity · 关联「Geography」*

</details>

*由 kgdiff <version> 生成*
