//! Localized hunk titles and facet labels, `en` and `zh-CN` (`i18n.ts`). Titles say what
//! happened in one line, naming the nodes involved; subtitles summarize the rest. English quotes
//! names “like this”, Chinese 「像这样」.

use crate::js::{IndexMap, IndexSet};

use crate::error::{KgdiffError, Result};
use crate::js::{self, JsStr, Object};
use crate::model::{
    AttrChange, Cause, ChangeStatus, EdgeFacet, End, FacetKind, Hunk, HunkKind, NodeFacet,
    UnionEdge, UnionId, UnionNode, Via,
};
use crate::pipeline::DiffResult;

/// A locale of the titles and labels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum Locale {
    #[default]
    En,
    ZhCn,
}

impl Locale {
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::ZhCn => "zh-CN",
        }
    }

    /// `en` or `zh-CN`; anything else falls back to `en`, as the TypeScript lookup does.
    pub fn from_name(name: &str) -> Locale {
        if name == "zh-CN" {
            Locale::ZhCn
        } else {
            Locale::En
        }
    }
}

#[derive(Clone, Copy)]
enum Noun {
    Relation,
    Attribute,
    Type,
    Synonym,
    Duplicate,
}

fn en_noun(noun: Noun) -> (&'static str, &'static str) {
    match noun {
        Noun::Relation => ("relation", "relations"),
        Noun::Attribute => ("attribute", "attributes"),
        Noun::Type => ("type", "types"),
        Noun::Synonym => ("synonym", "synonyms"),
        Noun::Duplicate => ("duplicate", "duplicates"),
    }
}

fn zh_noun(noun: Noun) -> (&'static str, &'static str) {
    match noun {
        Noun::Relation => ("条", "关系"),
        Noun::Attribute => ("个", "属性"),
        Noun::Type => ("个", "类型"),
        Noun::Synonym => ("个", "别名"),
        Noun::Duplicate => ("条", "重复关系"),
    }
}

/// Thousands separators without `Intl` (`int`).
fn int(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `${Math.round(x * 100)}%`.
fn percent(x: f64) -> String {
    format!("{}%", js::number_to_string(js::math::round(x * 100.0)))
}

fn delta_parts(added: usize, removed: usize, modified: usize) -> String {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("+{}", int(added)));
    }
    if removed > 0 {
        parts.push(format!("−{}", int(removed)));
    }
    if modified > 0 {
        parts.push(format!("~{}", int(modified)));
    }
    parts.join(" ")
}

/// Separates a display name from the id appended to tell equally named nodes apart.
const ID_MARK: char = '\u{0}';
const MAX_NAME: usize = 40;
const SEPARATOR: &str = " · ";

/// The phrases of one locale (`Phrasebook`).
#[derive(Clone, Copy)]
struct Book {
    zh: bool,
}

/// `${value}` of an optional string: `undefined` when absent, as a template literal writes it.
fn shown(value: Option<&String>) -> String {
    value.cloned().unwrap_or_else(|| "undefined".to_owned())
}

impl Book {
    fn quote(self, text: &str) -> String {
        let mut parts = text.split(ID_MARK);
        let name = parts.next().unwrap_or("");
        match (parts.next(), self.zh) {
            (None, false) => format!("“{text}”"),
            (Some(id), false) => format!("“{name}” ({id})"),
            (None, true) => format!("「{text}」"),
            (Some(id), true) => format!("「{name}」（{id}）"),
        }
    }

    fn count(self, n: usize, noun: Noun) -> String {
        if self.zh {
            let (classifier, word) = zh_noun(noun);
            format!("{} {classifier}{word}", int(n))
        } else {
            let (one, many) = en_noun(noun);
            format!("{} {}", int(n), if n == 1 { one } else { many })
        }
    }

    /// Names for titles: up to two shown, the rest counted.
    fn names(self, list: &[String], total: usize) -> String {
        let shown_names: Vec<String> = list.iter().take(2).map(|n| self.quote(n)).collect();
        let first = shown(shown_names.first());
        if total <= 1 {
            return shown_names.first().cloned().unwrap_or_default();
        }
        let second = shown(shown_names.get(1));
        match (total, self.zh) {
            (2, false) => format!("{first} and {second}"),
            (2, true) => format!("{first}和{second}"),
            (_, false) => format!("{first}, {second} and {} more", int(total - 2)),
            (_, true) => format!("{first}、{second}等 {} 个节点", int(total)),
        }
    }

    fn list(self, names: &[String]) -> String {
        self.names(names, names.len())
    }

    fn delta(self, noun: Noun, added: usize, removed: usize, modified: usize) -> String {
        let total = added + removed + modified;
        if total == 0 {
            return String::new();
        }
        if self.zh {
            format!(
                "{} {}",
                zh_noun(noun).1,
                delta_parts(added, removed, modified)
            )
        } else {
            let (one, many) = en_noun(noun);
            format!(
                "{} {}",
                delta_parts(added, removed, modified),
                if total == 1 { one } else { many }
            )
        }
    }

    /// `Added …` / `Removed …` of node groups (`grew`).
    fn grew(self, added: bool, nodes: &[String], total: usize, relations: usize) -> String {
        let first = self.quote(nodes.first().map_or("", String::as_str));
        let second = || self.quote(nodes.get(1).map_or("", String::as_str));
        if self.zh {
            let verb = if added { "新增" } else { "删除" };
            let subject = match total {
                0 | 1 => first,
                2 => format!("{first}和{}", second()),
                _ => format!("{first}等 {} 个节点", int(total)),
            };
            return if relations > 0 {
                format!(
                    "{verb}{subject}及 {}",
                    self.count(relations, Noun::Relation)
                )
            } else {
                format!("{verb}{subject}")
            };
        }
        let verb = if added { "Added" } else { "Removed" };
        let rel = if relations > 0 {
            self.count(relations, Noun::Relation)
        } else {
            String::new()
        };
        match total {
            0 | 1 if rel.is_empty() => format!("{verb} {first}"),
            0 | 1 => format!("{verb} {first} and {rel}"),
            2 if rel.is_empty() => format!("{verb} {first} and {}", second()),
            2 => format!("{verb} {first}, {} and {rel}", second()),
            _ => {
                let more = format!("{} more nodes", int(total - 1));
                if rel.is_empty() {
                    format!("{verb} {first} and {more}")
                } else {
                    format!("{verb} {first}, {more} and {rel}")
                }
            }
        }
    }

    fn arrow(self, s: &str, relation: &str, t: &str) -> String {
        if self.zh {
            format!("{}—{relation}→{}", self.quote(s), self.quote(t))
        } else {
            format!("{} —{relation}→ {}", self.quote(s), self.quote(t))
        }
    }
}

/// Facet names for `facet_label`.
fn facet_names(kind: FacetKind, locale: Locale) -> &'static str {
    match locale {
        Locale::En => match kind {
            FacetKind::Rekey => "Re-keyed",
            FacetKind::Rename => "Renamed",
            FacetKind::MergedInto => "Merged into",
            FacetKind::MergeTarget => "Merge target",
            FacetKind::SplitFrom => "Split from",
            FacetKind::SplitInto => "Split into",
            FacetKind::Move => "Moved",
            FacetKind::Deprecate => "Deprecated",
            FacetKind::Replacement => "Replacement links",
            FacetKind::Types => "Types changed",
            FacetKind::Aliases => "Synonyms changed",
            FacetKind::Attrs => "Attributes changed",
            FacetKind::Retarget => "Retargeted",
            FacetKind::Predicate => "Relation type changed",
            FacetKind::Label => "Relabeled",
            FacetKind::Collapsed => "Collapsed duplicate",
        },
        Locale::ZhCn => match kind {
            FacetKind::Rekey => "ID 变更",
            FacetKind::Rename => "改名",
            FacetKind::MergedInto => "合并入",
            FacetKind::MergeTarget => "合并目标",
            FacetKind::SplitFrom => "拆分自",
            FacetKind::SplitInto => "拆分为",
            FacetKind::Move => "移动",
            FacetKind::Deprecate => "弃用",
            FacetKind::Replacement => "替代关系",
            FacetKind::Types => "类型变更",
            FacetKind::Aliases => "别名变更",
            FacetKind::Attrs => "属性变更",
            FacetKind::Retarget => "改为指向",
            FacetKind::Predicate => "关系类型变更",
            FacetKind::Label => "标签变更",
            FacetKind::Collapsed => "重复合并",
        },
    }
}

/// Localized short name of a facet kind (`facetLabel`), e.g. `rename` → “Renamed” / “改名”.
pub fn facet_label(kind: FacetKind, locale: Locale) -> &'static str {
    facet_names(kind, locale)
}

/// Display names of several nodes; a name shared by different nodes gets each one's id
/// appended (`distinct`).
fn distinct(entries: &[(UnionId, String)]) -> Vec<String> {
    let mut ids: IndexMap<&str, IndexSet<&UnionId>> = IndexMap::default();
    for (id, name) in entries {
        ids.entry(name.as_str()).or_default().insert(id);
    }
    entries
        .iter()
        .map(|(id, name)| {
            if ids[name.as_str()].len() > 1 {
                format!("{name}{ID_MARK}{id}")
            } else {
                name.clone()
            }
        })
        .collect()
}

/// A label shortened to 40 code points (`shorten`).
fn shorten(label: &str) -> String {
    let chars: Vec<char> = label.chars().collect();
    if chars.len() > MAX_NAME {
        format!("{}…", chars[..MAX_NAME - 1].iter().collect::<String>())
    } else {
        label.to_owned()
    }
}

/// Display name of a union node: its label, shortened (`nameOf`).
fn name_of(diff: &DiffResult, id: &str) -> String {
    shorten(diff.node(id).map_or(id, |n| n.label.as_str()))
}

/// The name a node was known by before the change (`formerName`).
fn former_name(node: &UnionNode) -> String {
    shorten(
        node.before
            .as_ref()
            .map_or(node.label.as_str(), |b| b.label.as_str()),
    )
}

/// Display name of a node referenced from a replacement link (`nameOfLinked`).
fn name_of_linked(diff: &DiffResult, id: &str, after_side: bool) -> String {
    let node = if after_side {
        diff.node_by_after(id).or_else(|| diff.node_by_before(id))
    } else {
        diff.node_by_before(id).or_else(|| diff.node_by_after(id))
    };
    match node {
        None => id.to_owned(),
        Some(node) if after_side => name_of(diff, &node.id),
        Some(node) => former_name(node),
    }
}

fn attr_counts(changes: &[AttrChange]) -> (usize, usize, usize) {
    let mut c = (0, 0, 0);
    for change in changes {
        match (&change.before, &change.after) {
            (None, _) => c.0 += 1,
            (_, None) => c.1 += 1,
            _ => c.2 += 1,
        }
    }
    c
}

fn edge_counts(edges: &[&UnionEdge]) -> (usize, usize, usize) {
    let count = |s: ChangeStatus| edges.iter().filter(|e| e.status == s).count();
    (
        count(ChangeStatus::Added),
        count(ChangeStatus::Removed),
        count(ChangeStatus::Modified),
    )
}

fn join(parts: Vec<String>) -> String {
    parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(SEPARATOR)
}

/// Content facets of a node as subtitle phrases (`contentNotes`).
fn content_notes(p: Book, node: &UnionNode) -> Vec<String> {
    let mut notes = Vec::new();
    for f in &node.facets {
        if let NodeFacet::Attrs { changes } = f {
            let (a, r, m) = attr_counts(changes);
            notes.push(p.delta(Noun::Attribute, a, r, m));
            break;
        }
    }
    for f in &node.facets {
        if let NodeFacet::Types(c) = f {
            notes.push(p.delta(Noun::Type, c.added.len(), c.removed.len(), 0));
            break;
        }
    }
    for f in &node.facets {
        if let NodeFacet::Aliases(c) = f {
            notes.push(p.delta(Noun::Synonym, c.added.len(), c.removed.len(), 0));
            break;
        }
    }
    notes
}

/// Notes for a `replacement` facet (`linkNotes`).
fn link_notes(p: Book, diff: &DiffResult, node: &UnionNode) -> Vec<String> {
    let Some(NodeFacet::Replacement {
        replaces,
        replaced_by,
    }) = node
        .facets
        .iter()
        .find(|f| f.kind() == FacetKind::Replacement)
    else {
        return Vec::new();
    };
    let names = |ids: &[JsStr], after_side: bool| {
        p.list(
            &ids.iter()
                .map(|id| name_of_linked(diff, id, after_side))
                .collect::<Vec<_>>(),
        )
    };
    let mut notes = Vec::new();
    let current = node.after.as_ref().map_or(&[][..], |a| a.replaced_by());
    if !replaced_by.is_empty() {
        notes.push(if current.is_empty() {
            no_longer_replaced(p)
        } else {
            replaced_by_note(p, &names(current, true))
        });
    }
    if !replaces.added.is_empty() {
        notes.push(if p.zh {
            format!("替代{}", names(&replaces.added, false))
        } else {
            format!("replaces {}", names(&replaces.added, false))
        });
    } else if !replaces.removed.is_empty() {
        let list = names(&replaces.removed, false);
        notes.push(if p.zh {
            format!("不再替代{list}")
        } else {
            format!("no longer replaces {list}")
        });
    }
    notes
}

fn no_longer_replaced(p: Book) -> String {
    (if p.zh {
        "不再有替代项"
    } else {
        "no longer replaced"
    })
    .to_owned()
}

fn replaced_by_note(p: Book, nodes: &str) -> String {
    if p.zh {
        format!("由{nodes}替代")
    } else {
        format!("replaced by {nodes}")
    }
}

fn confidence_note(p: Book, contributions: &[(f64, Via)]) -> String {
    if contributions.iter().all(|(_, via)| *via == Via::Hint) {
        return (if p.zh {
            "依据替代声明"
        } else {
            "via replacement hint"
        })
        .to_owned();
    }
    let lowest = contributions
        .iter()
        .fold(f64::INFINITY, |min, (c, _)| js::math::min(min, *c));
    let pc = percent(lowest);
    match (
        contributions.iter().all(|(_, via)| *via == Via::Heuristic),
        p.zh,
    ) {
        (true, false) => format!("inferred · {pc} confidence"),
        (true, true) => format!("推断 · 置信度 {pc}"),
        (false, false) => format!("{pc} confidence"),
        (false, true) => format!("置信度 {pc}"),
    }
}

fn restructure_notes(p: Book, edges: &[&UnionEdge], cause: Cause) -> Vec<String> {
    let is_carried = |e: &UnionEdge| {
        e.facets
            .iter()
            .any(|f| matches!(f, EdgeFacet::Retarget { cause: c, .. } if *c == cause))
    };
    let is_collapsed = |e: &UnionEdge| {
        e.facets
            .iter()
            .any(|f| matches!(f, EdgeFacet::Collapsed { .. }))
    };
    let carried = edges.iter().filter(|e| is_carried(e)).count();
    let collapsed = edges.iter().filter(|e| is_collapsed(e)).count();
    let other: Vec<&UnionEdge> = edges
        .iter()
        .filter(|e| !is_carried(e) && !is_collapsed(e))
        .copied()
        .collect();
    let (a, r, m) = edge_counts(&other);
    vec![
        if carried > 0 {
            if p.zh {
                format!("迁移 {}", p.count(carried, Noun::Relation))
            } else {
                format!("{} carried over", p.count(carried, Noun::Relation))
            }
        } else {
            String::new()
        },
        if collapsed > 0 {
            if p.zh {
                format!("合并 {}", p.count(collapsed, Noun::Duplicate))
            } else {
                format!("{} collapsed", p.count(collapsed, Noun::Duplicate))
            }
        } else {
            String::new()
        },
        p.delta(Noun::Relation, a, r, m),
    ]
}

struct Parts<'a> {
    p: Book,
    diff: &'a DiffResult,
    hunk: &'a Hunk,
    nodes: Vec<&'a UnionNode>,
    edges: Vec<&'a UnionEdge>,
    anchor: Option<&'a UnionNode>,
}

fn format_merge(x: &Parts<'_>) -> (String, String) {
    let p = x.p;
    let sources: Vec<&UnionNode> = x
        .anchor
        .and_then(|a| {
            a.facets.iter().find_map(|f| {
                if let NodeFacet::MergeTarget { sources } = f {
                    Some(sources)
                } else {
                    None
                }
            })
        })
        .map(|ids| ids.iter().filter_map(|id| x.diff.node(id)).collect())
        .unwrap_or_default();
    let contributions: Vec<(f64, Via)> = sources
        .iter()
        .filter_map(|s| {
            s.facets.iter().find_map(|f| {
                if let NodeFacet::MergedInto {
                    confidence, via, ..
                } = f
                {
                    Some((*confidence, *via))
                } else {
                    None
                }
            })
        })
        .collect();
    let mut entries = vec![(x.hunk.anchor.clone(), name_of(x.diff, &x.hunk.anchor))];
    entries.extend(sources.iter().map(|s| {
        (
            s.before_id.clone().unwrap_or_else(|| s.id.clone()),
            former_name(s),
        )
    }));
    let named = distinct(&entries);
    let source_names = p.names(&named[1..], sources.len());
    let target = p.quote(&named[0]);
    let title = if p.zh {
        format!("{source_names}合并入{target}")
    } else {
        format!("Merged {source_names} into {target}")
    };
    let mut parts = vec![if contributions.is_empty() {
        String::new()
    } else {
        confidence_note(p, &contributions)
    }];
    parts.extend(restructure_notes(p, &x.edges, Cause::Merge));
    parts.push(
        if sources.iter().any(|s| s.status != ChangeStatus::Removed) {
            (if p.zh {
                "源节点保留为已弃用"
            } else {
                "kept as deprecated"
            })
            .to_owned()
        } else {
            String::new()
        },
    );
    if let Some(anchor) = x.anchor {
        parts.extend(content_notes(p, anchor));
    }
    (title, join(parts))
}

fn format_split(x: &Parts<'_>) -> (String, String) {
    let p = x.p;
    let target_ids: Vec<JsStr> = x
        .anchor
        .and_then(|a| {
            a.facets.iter().find_map(|f| {
                if let NodeFacet::SplitInto { targets } = f {
                    Some(targets.clone())
                } else {
                    None
                }
            })
        })
        .unwrap_or_default();
    let targets: Vec<&UnionNode> = target_ids.iter().filter_map(|id| x.diff.node(id)).collect();
    let contributions: Vec<(f64, Via)> = targets
        .iter()
        .filter_map(|t| {
            t.facets.iter().find_map(|f| {
                if let NodeFacet::SplitFrom {
                    confidence, via, ..
                } = f
                {
                    Some((*confidence, *via))
                } else {
                    None
                }
            })
        })
        .collect();
    let pivot = x.anchor.or_else(|| x.diff.node(&x.hunk.anchor));
    let mut entries = vec![(
        x.hunk.anchor.clone(),
        pivot.map(former_name).unwrap_or_default(),
    )];
    entries.extend(
        target_ids
            .iter()
            .map(|id| (id.clone(), name_of(x.diff, id))),
    );
    let named = distinct(&entries);
    let source = p.quote(&named[0]);
    let target_names = p.names(&named[1..], target_ids.len());
    let title = if p.zh {
        format!("{source}拆分为{target_names}")
    } else {
        format!("Split {source} into {target_names}")
    };
    let mut parts = vec![if contributions.is_empty() {
        String::new()
    } else {
        confidence_note(p, &contributions)
    }];
    parts.extend(restructure_notes(p, &x.edges, Cause::Split));
    parts.push(match x.anchor.and_then(|a| a.after.as_ref()) {
        None => String::new(),
        Some(kept) if kept.deprecated => (if p.zh {
            "源节点保留为已弃用"
        } else {
            "source kept as deprecated"
        })
        .to_owned(),
        Some(_) => (if p.zh {
            "源节点保留"
        } else {
            "source kept"
        })
        .to_owned(),
    });
    (title, join(parts))
}

fn format_group(x: &Parts<'_>, added: bool) -> (String, String) {
    let p = x.p;
    let ordered: Vec<String> = std::iter::once(&x.hunk.anchor)
        .chain(x.hunk.nodes.iter().filter(|id| **id != x.hunk.anchor))
        .map(|id| name_of(x.diff, id))
        .collect();
    let title = p.grew(added, &ordered, x.nodes.len(), x.hunk.edges.len());
    let context: Vec<String> = x
        .hunk
        .context
        .iter()
        .map(|id| name_of(x.diff, id))
        .collect();
    let types = x.anchor.map_or(&[][..], UnionNode::types);
    let typed = if types.is_empty() {
        String::new()
    } else {
        let list = types
            .iter()
            .map(JsStr::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        if p.zh {
            format!("类型 {list}")
        } else {
            format!("type {list}")
        }
    };
    let linked = if context.is_empty() {
        (if p.zh {
            "无外部关联"
        } else {
            "standalone"
        })
        .to_owned()
    } else {
        let list = p.list(&context);
        match (added, p.zh) {
            (true, false) => format!("linked to {list}"),
            (false, false) => format!("was linked to {list}"),
            (true, true) => format!("关联{list}"),
            (false, true) => format!("原关联{list}"),
        }
    };
    (title, join(vec![typed, linked]))
}

#[derive(PartialEq)]
enum Lead {
    Rename,
    Move,
    Deprecate,
    Rekey,
    Content,
}

fn format_modify(x: &Parts<'_>, node: &UnionNode) -> (String, String) {
    let p = x.p;
    let q = |s: &str| p.quote(s);
    let name = name_of(x.diff, &node.id);
    let rename = node.facets.iter().find_map(|f| {
        if let NodeFacet::Rename { from, to } = f {
            Some((from, to))
        } else {
            None
        }
    });
    let moves: Vec<(&JsStr, &Vec<UnionId>, &Vec<UnionId>)> = node
        .facets
        .iter()
        .filter_map(|f| {
            if let NodeFacet::Move {
                predicate,
                from,
                to,
            } = f
            {
                Some((predicate, from, to))
            } else {
                None
            }
        })
        .collect();
    let moved_to: Vec<String> = moves
        .iter()
        .flat_map(|m| m.2.iter())
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(|id| name_of(x.diff, id))
        .collect();
    let moved_from: Vec<String> = moves
        .iter()
        .flat_map(|m| m.1.iter())
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(|id| name_of(x.diff, id))
        .collect();
    let deprecate = node.facets.iter().find_map(|f| {
        if let NodeFacet::Deprecate { deprecated } = f {
            Some(*deprecated)
        } else {
            None
        }
    });
    let rekey = node.facets.iter().find_map(|f| {
        if let NodeFacet::Rekey { from, to, score } = f {
            Some((from, to, *score))
        } else {
            None
        }
    });
    // Hierarchy edges of a move are the move itself, not separate relation changes.
    let moved_predicates: Vec<&JsStr> = moves.iter().map(|m| m.0).collect();
    let own_edges: Vec<&UnionEdge> = x
        .edges
        .iter()
        .filter(|e| !(e.hierarchical && moved_predicates.contains(&&e.predicate)))
        .copied()
        .collect();
    let content: Vec<FacetKind> = node
        .facets
        .iter()
        .map(NodeFacet::kind)
        .filter(|k| {
            matches!(
                k,
                FacetKind::Attrs | FacetKind::Types | FacetKind::Aliases | FacetKind::Replacement
            )
        })
        .collect();

    let (title, lead) = if let Some((from, to)) = rename {
        let (from, to) = (shorten(from), shorten(to));
        (
            if p.zh {
                format!("{}改名为{}", q(&from), q(&to))
            } else {
                format!("Renamed {} → {}", q(&from), q(&to))
            },
            Lead::Rename,
        )
    } else if !moves.is_empty() {
        let title = if moved_to.is_empty() {
            let from = p.list(&moved_from);
            if p.zh {
                format!("{}脱离{from}", q(&name))
            } else {
                format!("Detached {} from {from}", q(&name))
            }
        } else {
            let under = p.list(&moved_to);
            if p.zh {
                format!("{}移至{under}下", q(&name))
            } else {
                format!("Moved {} under {under}", q(&name))
            }
        };
        (title, Lead::Move)
    } else if let Some(deprecated) = deprecate {
        let title = match (deprecated, p.zh) {
            (true, false) => format!("Deprecated {}", q(&name)),
            (false, false) => format!("Restored {}", q(&name)),
            (true, true) => format!("弃用{}", q(&name)),
            (false, true) => format!("恢复{}", q(&name)),
        };
        (title, Lead::Deprecate)
    } else if rekey.is_some() {
        (
            if p.zh {
                format!("{}的 ID 已变更", q(&name))
            } else {
                format!("Changed the id of {}", q(&name))
            },
            Lead::Rekey,
        )
    } else {
        let only = if content.len() == 1 && own_edges.is_empty() {
            content.first().copied()
        } else {
            None
        };
        let title = match (only, p.zh) {
            (Some(FacetKind::Attrs), false) => format!("Updated attributes of {}", q(&name)),
            (Some(FacetKind::Types), false) => format!("Changed the type of {}", q(&name)),
            (Some(FacetKind::Aliases), false) => format!("Updated synonyms of {}", q(&name)),
            (Some(FacetKind::Replacement), false) => {
                format!("Updated replacement links of {}", q(&name))
            }
            (_, false) => format!("Edited {}", q(&name)),
            (Some(FacetKind::Attrs), true) => format!("修改{}的属性", q(&name)),
            (Some(FacetKind::Types), true) => format!("修改{}的类型", q(&name)),
            (Some(FacetKind::Aliases), true) => format!("修改{}的别名", q(&name)),
            (Some(FacetKind::Replacement), true) => format!("修改{}的替代关系", q(&name)),
            (_, true) => format!("修改{}", q(&name)),
        };
        (title, Lead::Content)
    };

    let mut notes: Vec<String> = Vec::new();
    if let Some((from, to, score)) = rekey {
        notes.push(if p.zh {
            format!("ID {from} → {to}")
        } else {
            format!("{from} → {to}")
        });
        if score < 1.0 {
            let pc = percent(score);
            notes.push(if p.zh {
                format!("匹配度 {pc}")
            } else {
                format!("{pc} match")
            });
        }
    }
    notes.extend(content_notes(p, node));
    if !moves.is_empty() {
        if lead != Lead::Move {
            notes.push(if moved_to.is_empty() {
                let list = p.list(&moved_from);
                if p.zh {
                    format!("脱离{list}")
                } else {
                    format!("detached from {list}")
                }
            } else {
                let list = p.list(&moved_to);
                if p.zh {
                    format!("移至{list}下")
                } else {
                    format!("moved under {list}")
                }
            });
        } else if !moved_to.is_empty() && !moved_from.is_empty() {
            let list = p.list(&moved_from);
            notes.push(if p.zh {
                format!("原属{list}")
            } else {
                format!("from {list}")
            });
        }
    }
    if let Some(deprecated) = deprecate
        && lead != Lead::Deprecate
    {
        notes.push(
            match (deprecated, p.zh) {
                (true, false) => "deprecated",
                (false, false) => "restored",
                (true, true) => "已弃用",
                (false, true) => "已恢复",
            }
            .to_owned(),
        );
    }
    notes.extend(link_notes(p, x.diff, node));
    let (a, r, m) = edge_counts(&own_edges);
    notes.push(p.delta(Noun::Relation, a, r, m));
    (title, join(notes))
}

fn format_relations(x: &Parts<'_>) -> (String, String) {
    let p = x.p;
    let q = |s: &str| p.quote(s);
    let source = name_of(x.diff, &x.hunk.anchor);
    let [edge] = x.edges.as_slice() else {
        let (added, removed, modified) = edge_counts(&x.edges);
        let n = x.edges.len();
        let count = p.count(n, Noun::Relation);
        let title = match (added == n, removed == n, p.zh) {
            (true, _, false) => format!("Added {count} to {}", q(&source)),
            (false, true, false) => format!("Removed {count} from {}", q(&source)),
            (false, false, false) => format!("Updated {count} of {}", q(&source)),
            (true, _, true) => format!("为{}新增 {count}", q(&source)),
            (false, true, true) => format!("删除{}的 {count}", q(&source)),
            (false, false, true) => format!("修改{}的 {count}", q(&source)),
        };
        let retargeted = x
            .edges
            .iter()
            .filter(|e| e.facets.iter().any(|f| f.kind() == FacetKind::Retarget))
            .count();
        let retargeted = if retargeted > 0 {
            if p.zh {
                format!("{} 条关系改为指向新节点", int(retargeted))
            } else {
                format!("{} retargeted", int(retargeted))
            }
        } else {
            String::new()
        };
        return (
            title,
            join(vec![
                p.delta(Noun::Relation, added, removed, modified),
                retargeted,
            ]),
        );
    };
    let relation = shorten(&edge.label);
    let retargets: Vec<(End, &UnionId, &UnionId)> = edge
        .facets
        .iter()
        .filter_map(|f| {
            if let EdgeFacet::Retarget { end, from, to, .. } = f {
                Some((*end, from, to))
            } else {
                None
            }
        })
        .collect();
    let single = if retargets.len() == 1 {
        Some(retargets[0])
    } else {
        None
    };
    let mut ends: Vec<UnionId> = vec![edge.source.clone(), edge.target.clone()];
    if let Some((_, from, to)) = single {
        ends.push(from.clone());
        ends.push(to.clone());
    }
    let named = distinct(
        &ends
            .iter()
            .map(|id| (id.clone(), name_of(x.diff, id)))
            .collect::<Vec<_>>(),
    );
    let at = |i: usize| named.get(i).cloned().unwrap_or_default();
    let (s, t, from, to) = (at(0), at(1), at(2), at(3));
    let predicate = edge.facets.iter().find_map(|f| {
        if let EdgeFacet::Predicate { from, .. } = f {
            Some(from)
        } else {
            None
        }
    });
    let label = edge.facets.iter().find_map(|f| {
        if let EdgeFacet::Label { from, to } = f {
            Some((from, to))
        } else {
            None
        }
    });
    let attrs = edge.facets.iter().find_map(|f| {
        if let EdgeFacet::Attrs { changes } = f {
            Some(changes)
        } else {
            None
        }
    });
    let mut extras = vec![
        label.map_or_else(String::new, |(from, to)| {
            let (from, to) = (shorten(from), shorten(to));
            if p.zh {
                format!("标签{}→{}", q(&from), q(&to))
            } else {
                format!("label {} → {}", q(&from), q(&to))
            }
        }),
        attrs.map_or_else(String::new, |changes| {
            let (a, r, m) = attr_counts(changes);
            p.delta(Noun::Attribute, a, r, m)
        }),
        if edge.hierarchical {
            (if p.zh { "层级关系" } else { "hierarchy" }).to_owned()
        } else {
            String::new()
        },
    ];
    let with = |lead: &str, extras: &mut Vec<String>| {
        let mut parts = vec![lead.to_owned()];
        parts.append(extras);
        join(parts)
    };
    if let (Some((end, _, _)), None) = (single, predicate) {
        return if end == End::Target {
            let title = if p.zh {
                format!(
                    "{}的{}改为指向{}（原为{}）",
                    q(&s),
                    q(&relation),
                    q(&to),
                    q(&from)
                )
            } else {
                format!(
                    "{}: {relation} now points to {} (was {})",
                    q(&s),
                    q(&to),
                    q(&from)
                )
            };
            (
                title,
                with(
                    if p.zh {
                        "关系改为指向新节点"
                    } else {
                        "relation retargeted"
                    },
                    &mut extras,
                ),
            )
        } else {
            let title = if p.zh {
                format!(
                    "{}的{}改为来自{}（原为{}）",
                    q(&t),
                    q(&relation),
                    q(&to),
                    q(&from)
                )
            } else {
                format!(
                    "{}: {relation} now comes from {} (was {})",
                    q(&t),
                    q(&to),
                    q(&from)
                )
            };
            (
                title,
                with(
                    if p.zh {
                        "关系改为来自新节点"
                    } else {
                        "relation moved to another subject"
                    },
                    &mut extras,
                ),
            )
        };
    }
    if let Some(predicate_from) = predicate
        && retargets.is_empty()
    {
        let before = shorten(
            edge.before
                .as_ref()
                .map_or(predicate_from.as_str(), |b| b.label.as_str()),
        );
        let title = if p.zh {
            format!(
                "{}→{}的关系由{}改为{}",
                q(&s),
                q(&t),
                q(&before),
                q(&relation)
            )
        } else {
            format!("{} → {}: {before} is now {relation}", q(&s), q(&t))
        };
        return (
            title,
            with(
                if p.zh {
                    "关系类型变更"
                } else {
                    "relation type changed"
                },
                &mut extras,
            ),
        );
    }
    match edge.status {
        ChangeStatus::Added => {
            let arrow = p.arrow(&s, &relation, &t);
            (
                if p.zh {
                    format!("新增关系{arrow}")
                } else {
                    format!("Added {arrow}")
                },
                with(if p.zh { "新关系" } else { "new relation" }, &mut extras),
            )
        }
        ChangeStatus::Removed => {
            let arrow = p.arrow(&s, &relation, &t);
            (
                if p.zh {
                    format!("删除关系{arrow}")
                } else {
                    format!("Removed {arrow}")
                },
                with(
                    if p.zh {
                        "关系已删除"
                    } else {
                        "relation removed"
                    },
                    &mut extras,
                ),
            )
        }
        _ => {
            let arrow = p.arrow(&s, &relation, &t);
            (
                if p.zh {
                    format!("修改关系{arrow}")
                } else {
                    format!("Edited {arrow}")
                },
                join(extras),
            )
        }
    }
}

/// Localized one-line title and subtitle of a hunk (`formatHunk`), e.g. `Merged “A” into “B”`
/// / `3 relations carried over`.
///
/// # Errors
///
/// `invalid-input` when the hunk does not belong to `diff`.
pub fn format_hunk(hunk: &Hunk, diff: &DiffResult, locale: Locale) -> Result<(String, String)> {
    let nodes: Option<Vec<&UnionNode>> = hunk.nodes.iter().map(|id| diff.node(id)).collect();
    let edges: Option<Vec<&UnionEdge>> = hunk.edges.iter().map(|id| diff.edge(id)).collect();
    let (Some(nodes), Some(edges)) = (nodes, edges) else {
        let mut details = Object::new();
        details.insert("hunk", &hunk.id);
        return Err(KgdiffError::invalid_input(format!(
            "Hunk \"{}\" does not belong to this diff",
            hunk.id
        ))
        .with_details(details));
    };
    let parts = Parts {
        p: Book {
            zh: locale == Locale::ZhCn,
        },
        diff,
        hunk,
        nodes,
        edges,
        anchor: diff.node(&hunk.anchor),
    };
    Ok(match hunk.kind {
        HunkKind::Merge => format_merge(&parts),
        HunkKind::Split => format_split(&parts),
        HunkKind::Add => format_group(&parts, true),
        HunkKind::Remove => format_group(&parts, false),
        HunkKind::Modify => match parts.anchor {
            Some(anchor) => format_modify(&parts, anchor),
            None => format_relations(&parts),
        },
        HunkKind::Relations => format_relations(&parts),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_thousands() {
        assert_eq!(int(0), "0");
        assert_eq!(int(999), "999");
        assert_eq!(int(1000), "1,000");
        assert_eq!(int(1_234_567), "1,234,567");
        assert_eq!(percent(0.856), "86%");
        assert_eq!(shorten(&"x".repeat(41)), format!("{}…", "x".repeat(39)));
    }
}
