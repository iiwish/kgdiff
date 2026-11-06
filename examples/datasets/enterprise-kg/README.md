# enterprise-kg · 企业信用知识图谱本体 v12 → v13

The ontology catalog behind a Chinese enterprise-credit knowledge graph, the kind of model that
powers business-registration, risk-monitoring and due-diligence products. It is the featured
dataset of the demo site in Chinese; [`enterprise-kg-en`](../enterprise-kg-en/) is the same
dataset in English, and a test keeps the two identical apart from their texts.

企业信用知识图谱的本体目录：8 个业务领域下的主体、关系、事件、文书、名单、资产等概念，
以及每个概念的属性到物理表字段的映射（如 `统一社会信用代码 → ent_basic_info.credit_code`）。
v13 是一次典型的本体治理发版：合并同义概念、补充受益所有人、下线停更数据源、调整领域归属。

| | v12 | v13 |
| --- | --- | --- |
| nodes | 74 | 74 |
| edges | 171 | 171 |
| format | kgdiff JSON | kgdiff JSON |

## What it models

- **Domains** (type `领域`): 市场主体, 股权投资, 任职治理, 工商变更, 经营风险, 司法诉讼,
  知识产权, 上市证券. Every concept hangs under a domain or a parent concept through `is_a`
  (displayed as 属于).
- **Concepts**, typed 主体 / 角色 / 关系 / 机构 / 事件 / 文书 / 名单 / 措施 / 资产 / 披露 / 资质 / 板块:
  企业, 个体工商户, 上市公司, 自然人, 金融机构, 投资, 实际控制, 法定代表人, 董事会, 工商变更记录,
  企业年报, 行政处罚, 经营异常, 严重违法, 司法案件, 裁判文书, 被执行人, 失信被执行人, 限制高消费,
  专利, 发明人, 商标, 软件著作权, 证券, 公告, 股本结构, 十大股东, 交易板块 …
- **Relations** with Chinese predicates: 投资 is reified as a relation concept (出资方 / 被投资方 / 形成),
  roles point at the party that plays them (对应主体), plus 持股, 任职, 控制, 涉及, 报送, 持有, 发布,
  披露, 列入, 上市于 …
- **Attributes** map logical attributes to physical columns, e.g. 企业.注册资本 →
  `ent_basic_info.reg_cap`. Ids are stable catalog codes (`ENTERPRISE`, `LEGAL_REP`, …).

## Changes v12 → v13

| # | Change | Element | kgdiff reports |
| --- | --- | --- | --- |
| 1 | 法人代表 merged into 法定代表人 | `LEGAL_PERSON_REP` → `LEGAL_REP` | merge (hint: `replacedBy` on the deprecated source, `replaces` on the target; both get a `replacement` facet); alias 法人代表 added to 法定代表人; 2 source edges collapsed, 1 carried (`代表 → 农民专业合作社`) |
| 2 | 十大股东 –持股→ 企业 now points at 上市公司 | `TOP10_HOLDERS` | edge retarget (cause edit) |
| 3 | 高管任职 renamed 董监高任职 (old name kept as alias) | `EXEC_TENURE` | rename + alias added |
| 4 | 企业: +实缴资本, +经营范围, −注册地址 | `ENTERPRISE` | attrs |
| 5 | New 受益所有人 (beneficial owner) with 对应主体 → 自然人 and 受益于 → 企业 | `BENEFICIAL_OWNER` | added node + 3 added edges (incl. `is_a 股权投资`) |
| 6 | 抽查检查 dropped together with its 涉及 → 企业 relation | `SPOT_CHECK` | removed node + 2 removed edges |
| 7 | 股权出质 moved from 经营风险 to 股权投资 | `EQUITY_PLEDGE` | move (`is_a`), hierarchy edge retarget (cause move) |
| 8 | 失信被执行人 aliases: −老赖 (colloquial), +失信人 | `DISHONEST_EXECUTEE` | aliases |
| 9 | New relation 实际控制 –穿透依据→ 投资 | `ACTUAL_CONTROL` | added edge |
| 10 | 中外合资企业 deprecated (Foreign Investment Law transition ended 2024-12-31) | `SINO_FOREIGN_JV` | deprecate |
| 11 | 企业 –公示→ 企业年报 becomes –报送→ (companies submit; the registry publishes) | `ENTERPRISE` | predicate change |
| 12 | 限制高消费 retyped 名单 → 措施 (it is a court enforcement measure) | `CONSUMPTION_RESTRICTION` | types |
| 13 | 商标.商标状态 column moved to `ip_trademark.legal_status` | `TRADEMARK` | attrs (value change) |

Review hunks in default order: `remove:SPOT_CHECK`, `merge:LEGAL_REP`, `modify:EQUITY_PLEDGE`,
`relations:TOP10_HOLDERS`, `relations:ACTUAL_CONTROL`, `modify:ENTERPRISE`, `modify:SINO_FOREIGN_JV`,
`modify:TRADEMARK`, `modify:DISHONEST_EXECUTEE`, `modify:EXEC_TENURE`, `modify:CONSUMPTION_RESTRICTION`,
`add:BENEFICIAL_OWNER`.

## Files

- `before.json`, `after.json`: kgdiff native JSON (`nodes[]` with `id`, `label`, `type`, `aliases`,
  `deprecated`, `replacedBy`, `replaces`, `attrs`; `edges[]` with `source`, `predicate`, `target`, `label`).
- `meta.json`: options `{ "match": { "strategy": "auto" }, "hierarchyPredicates": ["is_a"] }`.
- `expected.json`: the exact changes above, in the format of [`../expected.schema.json`](../expected.schema.json).

The catalog is fictional and simplified; table and column names are illustrative. License: CC0-1.0.
