# enterprise-kg-en · Enterprise credit KG ontology v12 → v13

The ontology catalog behind an enterprise-credit knowledge graph, the kind of model that powers
business-registration, risk-monitoring and due-diligence products. It is the featured dataset of
the demo site in English.

This is [`enterprise-kg`](../enterprise-kg/) in English: the same ids, edges, flags, column
mappings and changes, with every label, type, alias, attribute name, description and predicate
translated. Both report the same changes, hunk for hunk; a test in
`packages/core/test/datasets.test.ts` fails when one is edited without the other. The demo site
shows the one in the reader's language.

| | v12 | v13 |
| --- | --- | --- |
| nodes | 74 | 74 |
| edges | 171 | 171 |
| format | kgdiff JSON | kgdiff JSON |

## What it models

- **Domains** (type `Domain`): Market entities, Equity and investment, Positions and governance,
  Business registration, Operational risk, Litigation, Intellectual property, Listed securities.
  Every concept hangs under a domain or a parent concept through `is_a` (displayed as
  "belongs to").
- **Concepts**, typed Entity / Role / Relation / Organization / Event / Document / List / Measure /
  Asset / Disclosure / Qualification / Market board: Enterprise, Individual business, Listed
  company, Natural person, Financial institution, Investment, Actual control, Legal
  representative, Board of directors, Registration change, Annual report, Administrative
  penalty, Abnormal operations, Serious violation, Court case, Judgment, Judgment debtor,
  Defaulting judgment debtor, Consumption restriction, Patent, Inventor, Trademark, Software
  copyright, Security, Announcement, Share capital, Top 10 shareholders, Trading board …
- **Relations**: Investment is reified as a relation concept (`investor` / `investee` /
  `yields`), roles point at the party that plays them (`playedBy`), plus `holdsSharesIn`,
  `servesAt`, `controls`, `concerns`, `submits`, `owns`, `releases`, `discloses`, `listedIn`,
  `listedOn` …
- **Attributes** map logical attributes to physical columns, e.g. Enterprise."Registered
  capital" → `ent_basic_info.reg_cap`. Ids are stable catalog codes (`ENTERPRISE`, `LEGAL_REP`, …).

## Changes v12 → v13

| # | Change | Element | kgdiff reports |
| --- | --- | --- | --- |
| 1 | Legal person representative merged into Legal representative | `LEGAL_PERSON_REP` → `LEGAL_REP` | merge (hint: `replacedBy` on the deprecated source, `replaces` on the target; both get a `replacement` facet); alias "Legal person representative" added to Legal representative; 2 source edges collapsed, 1 carried (`represents → Farmers' cooperative`) |
| 2 | Top 10 shareholders –holdsSharesIn→ Enterprise now points at Listed company | `TOP10_HOLDERS` | edge retarget (cause edit) |
| 3 | Executive tenure renamed Board and executive tenure (old name kept as alias) | `EXEC_TENURE` | rename + alias added |
| 4 | Enterprise: +Paid-in capital, +Business scope, −Registered address | `ENTERPRISE` | attrs |
| 5 | New Beneficial owner with `playedBy` → Natural person and `benefitsFrom` → Enterprise | `BENEFICIAL_OWNER` | added node + 3 added edges (incl. `is_a` Equity and investment) |
| 6 | Spot check dropped together with its `concerns` → Enterprise relation | `SPOT_CHECK` | removed node + 2 removed edges |
| 7 | Equity pledge moved from Operational risk to Equity and investment | `EQUITY_PLEDGE` | move (`is_a`), hierarchy edge retarget (cause move) |
| 8 | Defaulting judgment debtor aliases: −Deadbeat (colloquial), +Discredited person | `DISHONEST_EXECUTEE` | aliases |
| 9 | New relation Actual control –tracedThrough→ Investment | `ACTUAL_CONTROL` | added edge |
| 10 | Sino-foreign joint venture deprecated (the Foreign Investment Law transition ended 2024-12-31) | `SINO_FOREIGN_JV` | deprecate |
| 11 | Enterprise –publishes→ Annual report becomes –submits→ (companies submit; the registry publishes) | `ENTERPRISE` | predicate change |
| 12 | Consumption restriction retyped List → Measure (it is a court enforcement measure) | `CONSUMPTION_RESTRICTION` | types |
| 13 | Trademark."Trademark status" column moved to `ip_trademark.legal_status` | `TRADEMARK` | attrs (value change) |

Review hunks in default order: `remove:SPOT_CHECK`, `merge:LEGAL_REP`, `modify:EQUITY_PLEDGE`,
`relations:ACTUAL_CONTROL`, `relations:TOP10_HOLDERS`, `modify:ENTERPRISE`, `modify:EXEC_TENURE`,
`modify:CONSUMPTION_RESTRICTION`, `modify:DISHONEST_EXECUTEE`, `modify:SINO_FOREIGN_JV`,
`modify:TRADEMARK`, `add:BENEFICIAL_OWNER`. The hunks are those of `enterprise-kg`; ties in
the review order go by the anchor's label, so a few swap places in translation.

## Files

- `before.json`, `after.json`: kgdiff native JSON (`nodes[]` with `id`, `label`, `type`, `aliases`,
  `deprecated`, `replacedBy`, `replaces`, `attrs`; `edges[]` with `source`, `predicate`, `target`, `label`).
- `meta.json`: options `{ "match": { "strategy": "auto" }, "hierarchyPredicates": ["is_a"] }`.
- `expected.json`: the exact changes above, in the format of [`../expected.schema.json`](../expected.schema.json).

The catalog is fictional and simplified; table and column names are illustrative. License: CC0-1.0.
