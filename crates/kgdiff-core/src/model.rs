//! The normalized graph (`KGraph` and its parts in `types.ts`).

use std::sync::{Arc, OnceLock};

use crate::js::IndexMap;

use crate::js::{JsStr, Object, Value};

/// Identifier of a node within one graph version.
pub type Id = JsStr;
/// Identity key of an edge within one graph version.
pub type EdgeKey = JsStr;
/// Identifier of an element of the union graph.
pub type UnionId = JsStr;
/// A JSON attribute value.
pub type AttrValue = Value;
/// An attribute map.
pub type Attrs = Object;

/// A pinned layout position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// How edges are identified within a version and matched across versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum EdgeIdentity {
    /// An edge is its (source, predicate, target) triple.
    #[default]
    Structure,
    /// Edges carry stable ids (falling back to structure for edges without one).
    Id,
}

impl EdgeIdentity {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeIdentity::Structure => "structure",
            EdgeIdentity::Id => "id",
        }
    }

    pub fn from_name(name: &str) -> Option<EdgeIdentity> {
        match name {
            "structure" => Some(EdgeIdentity::Structure),
            "id" => Some(EdgeIdentity::Id),
            _ => None,
        }
    }
}

/// A normalized node.
#[derive(Clone, Debug, PartialEq)]
pub struct KGNode {
    pub id: Id,
    /// Never empty: falls back to the id.
    pub label: JsStr,
    /// Sorted, unique.
    pub types: Vec<JsStr>,
    /// Sorted, unique, never contains `label`.
    pub aliases: Vec<JsStr>,
    pub attrs: Attrs,
    pub deprecated: bool,
    /// Sorted, unique.
    pub replaces: Vec<Id>,
    /// Sorted, unique.
    pub replaced_by: Vec<Id>,
    /// Created implicitly for a dangling edge endpoint.
    pub implicit: bool,
    pub position: Option<Point>,
}

/// A normalized edge.
#[derive(Clone, Debug, PartialEq)]
pub struct KGEdge {
    pub key: EdgeKey,
    pub id: Option<Id>,
    pub source: Id,
    pub target: Id,
    pub predicate: JsStr,
    pub label: JsStr,
    pub attrs: Attrs,
}

/// Codes of the issues `normalize` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GraphIssueCode {
    DuplicateNode,
    DanglingEdge,
    DuplicateEdge,
    EmptyId,
    InvalidAttr,
}

impl GraphIssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            GraphIssueCode::DuplicateNode => "duplicate-node",
            GraphIssueCode::DanglingEdge => "dangling-edge",
            GraphIssueCode::DuplicateEdge => "duplicate-edge",
            GraphIssueCode::EmptyId => "empty-id",
            GraphIssueCode::InvalidAttr => "invalid-attr",
        }
    }
}

/// Something `normalize` repaired.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphIssue {
    pub code: GraphIssueCode,
    pub message: String,
    /// The node id or edge key the issue refers to.
    pub reference: Option<JsStr>,
}

impl GraphIssue {
    /// `{ code, message, ref? }`.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("code", self.code.as_str());
        out.insert("message", self.message.as_str());
        if let Some(reference) = &self.reference {
            out.insert("ref", reference);
        }
        Value::Object(out)
    }
}

/// A normalized, indexed, immutable graph (`normalize`).
#[derive(Clone, Debug)]
pub struct KGraph {
    pub meta: Object,
    pub nodes: IndexMap<Id, Arc<KGNode>>,
    pub edges: IndexMap<EdgeKey, Arc<KGEdge>>,
    /// Edge keys by source node id, in edge order.
    pub outgoing: IndexMap<Id, Vec<EdgeKey>>,
    /// Edge keys by target node id, in edge order.
    pub incoming: IndexMap<Id, Vec<EdgeKey>>,
    pub edge_identity: EdgeIdentity,
    pub issues: Vec<GraphIssue>,
    /// `hash_graph`, computed once.
    pub(crate) hash: OnceLock<String>,
}

impl KGraph {
    /// Number of edge ends at a node (a self-loop counts twice); 0 for an absent id (`degree`).
    pub fn degree(&self, id: Option<&str>) -> usize {
        let Some(id) = id else { return 0 };
        self.outgoing.get(id).map_or(0, Vec::len) + self.incoming.get(id).map_or(0, Vec::len)
    }
}

// ─── The diff: the union graph ───────────────────────────────────────────────

fn strings(list: &[JsStr]) -> Value {
    Value::Array(list.iter().map(Value::from).collect())
}

/// `unchanged`, `added`, `removed` or `modified`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeStatus {
    Unchanged,
    Added,
    Removed,
    Modified,
}

impl ChangeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeStatus::Unchanged => "unchanged",
            ChangeStatus::Added => "added",
            ChangeStatus::Removed => "removed",
            ChangeStatus::Modified => "modified",
        }
    }

    pub fn from_name(name: &str) -> Option<ChangeStatus> {
        match name {
            "unchanged" => Some(ChangeStatus::Unchanged),
            "added" => Some(ChangeStatus::Added),
            "removed" => Some(ChangeStatus::Removed),
            "modified" => Some(ChangeStatus::Modified),
            _ => None,
        }
    }
}

/// An attribute change: `before` absent → added, `after` absent → removed.
#[derive(Clone, Debug, PartialEq)]
pub struct AttrChange {
    pub key: JsStr,
    pub before: Option<AttrValue>,
    pub after: Option<AttrValue>,
}

impl AttrChange {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("key", &self.key);
        if let Some(before) = &self.before {
            out.insert("before", before.clone());
        }
        if let Some(after) = &self.after {
            out.insert("after", after.clone());
        }
        Value::Object(out)
    }
}

fn changes_value(changes: &[AttrChange]) -> Value {
    Value::Array(changes.iter().map(AttrChange::to_value).collect())
}

/// Elements added to and removed from a sorted set.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SetChange {
    pub added: Vec<JsStr>,
    pub removed: Vec<JsStr>,
}

impl SetChange {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }

    fn insert_into(&self, out: &mut Object) {
        out.insert("added", strings(&self.added));
        out.insert("removed", strings(&self.removed));
    }

    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        self.insert_into(&mut out);
        Value::Object(out)
    }
}

/// How a merge or split was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Via {
    Hint,
    Heuristic,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Hint => "hint",
            Via::Heuristic => "heuristic",
        }
    }
}

/// Why an edge endpoint changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    Edit,
    Merge,
    Split,
    Move,
}

impl Cause {
    pub fn as_str(self) -> &'static str {
        match self {
            Cause::Edit => "edit",
            Cause::Merge => "merge",
            Cause::Split => "split",
            Cause::Move => "move",
        }
    }
}

/// An edge end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum End {
    Source,
    Target,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Source => "source",
            End::Target => "target",
        }
    }
}

/// Every facet kind, in canonical facet order (`FACET_ORDER`, docs/algorithms.md §4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FacetKind {
    Rekey,
    Rename,
    MergedInto,
    MergeTarget,
    SplitFrom,
    SplitInto,
    Move,
    Deprecate,
    Replacement,
    Types,
    Aliases,
    Attrs,
    Retarget,
    Predicate,
    Label,
    Collapsed,
}

impl FacetKind {
    /// `FACET_ORDER`.
    pub const ALL: [FacetKind; 16] = [
        FacetKind::Rekey,
        FacetKind::Rename,
        FacetKind::MergedInto,
        FacetKind::MergeTarget,
        FacetKind::SplitFrom,
        FacetKind::SplitInto,
        FacetKind::Move,
        FacetKind::Deprecate,
        FacetKind::Replacement,
        FacetKind::Types,
        FacetKind::Aliases,
        FacetKind::Attrs,
        FacetKind::Retarget,
        FacetKind::Predicate,
        FacetKind::Label,
        FacetKind::Collapsed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FacetKind::Rekey => "rekey",
            FacetKind::Rename => "rename",
            FacetKind::MergedInto => "mergedInto",
            FacetKind::MergeTarget => "mergeTarget",
            FacetKind::SplitFrom => "splitFrom",
            FacetKind::SplitInto => "splitInto",
            FacetKind::Move => "move",
            FacetKind::Deprecate => "deprecate",
            FacetKind::Replacement => "replacement",
            FacetKind::Types => "types",
            FacetKind::Aliases => "aliases",
            FacetKind::Attrs => "attrs",
            FacetKind::Retarget => "retarget",
            FacetKind::Predicate => "predicate",
            FacetKind::Label => "label",
            FacetKind::Collapsed => "collapsed",
        }
    }

    pub fn from_name(name: &str) -> Option<FacetKind> {
        FacetKind::ALL.into_iter().find(|k| k.as_str() == name)
    }

    /// Position in `FACET_ORDER`.
    pub fn index(self) -> usize {
        self as usize
    }
}

/// A semantic change of a node.
#[derive(Clone, Debug, PartialEq)]
pub enum NodeFacet {
    Rename {
        from: JsStr,
        to: JsStr,
    },
    Rekey {
        from: Id,
        to: Id,
        score: f64,
    },
    Types(SetChange),
    Aliases(SetChange),
    Attrs {
        changes: Vec<AttrChange>,
    },
    /// Parents removed and added (union ids, sorted) under a hierarchy predicate.
    Move {
        predicate: JsStr,
        from: Vec<UnionId>,
        to: Vec<UnionId>,
    },
    Deprecate {
        deprecated: bool,
    },
    Replacement {
        replaces: SetChange,
        replaced_by: SetChange,
    },
    MergedInto {
        target: UnionId,
        confidence: f64,
        via: Via,
    },
    MergeTarget {
        sources: Vec<UnionId>,
    },
    SplitFrom {
        source: UnionId,
        confidence: f64,
        via: Via,
    },
    SplitInto {
        targets: Vec<UnionId>,
    },
}

impl NodeFacet {
    pub fn kind(&self) -> FacetKind {
        match self {
            NodeFacet::Rename { .. } => FacetKind::Rename,
            NodeFacet::Rekey { .. } => FacetKind::Rekey,
            NodeFacet::Types(_) => FacetKind::Types,
            NodeFacet::Aliases(_) => FacetKind::Aliases,
            NodeFacet::Attrs { .. } => FacetKind::Attrs,
            NodeFacet::Move { .. } => FacetKind::Move,
            NodeFacet::Deprecate { .. } => FacetKind::Deprecate,
            NodeFacet::Replacement { .. } => FacetKind::Replacement,
            NodeFacet::MergedInto { .. } => FacetKind::MergedInto,
            NodeFacet::MergeTarget { .. } => FacetKind::MergeTarget,
            NodeFacet::SplitFrom { .. } => FacetKind::SplitFrom,
            NodeFacet::SplitInto { .. } => FacetKind::SplitInto,
        }
    }

    /// The facet as `diffToJSON` writes it.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("kind", self.kind().as_str());
        match self {
            NodeFacet::Rename { from, to } => {
                out.insert("from", from);
                out.insert("to", to);
            }
            NodeFacet::Rekey { from, to, score } => {
                out.insert("from", from);
                out.insert("to", to);
                out.insert("score", *score);
            }
            NodeFacet::Types(change) | NodeFacet::Aliases(change) => change.insert_into(&mut out),
            NodeFacet::Attrs { changes } => {
                out.insert("changes", changes_value(changes));
            }
            NodeFacet::Move {
                predicate,
                from,
                to,
            } => {
                out.insert("predicate", predicate);
                out.insert("from", strings(from));
                out.insert("to", strings(to));
            }
            NodeFacet::Deprecate { deprecated } => {
                out.insert("deprecated", *deprecated);
            }
            NodeFacet::Replacement {
                replaces,
                replaced_by,
            } => {
                out.insert("replaces", replaces.to_value());
                out.insert("replacedBy", replaced_by.to_value());
            }
            NodeFacet::MergedInto {
                target,
                confidence,
                via,
            } => {
                out.insert("target", target);
                out.insert("confidence", *confidence);
                out.insert("via", via.as_str());
            }
            NodeFacet::MergeTarget { sources } => {
                out.insert("sources", strings(sources));
            }
            NodeFacet::SplitFrom {
                source,
                confidence,
                via,
            } => {
                out.insert("source", source);
                out.insert("confidence", *confidence);
                out.insert("via", via.as_str());
            }
            NodeFacet::SplitInto { targets } => {
                out.insert("targets", strings(targets));
            }
        }
        Value::Object(out)
    }
}

/// A semantic change of an edge.
#[derive(Clone, Debug, PartialEq)]
pub enum EdgeFacet {
    Retarget {
        end: End,
        from: UnionId,
        to: UnionId,
        cause: Cause,
    },
    Predicate {
        from: JsStr,
        to: JsStr,
    },
    Label {
        from: JsStr,
        to: JsStr,
    },
    Attrs {
        changes: Vec<AttrChange>,
    },
    /// Removed because, after a merge, it would duplicate the union edge `into`.
    Collapsed {
        into: UnionId,
    },
}

impl EdgeFacet {
    pub fn kind(&self) -> FacetKind {
        match self {
            EdgeFacet::Retarget { .. } => FacetKind::Retarget,
            EdgeFacet::Predicate { .. } => FacetKind::Predicate,
            EdgeFacet::Label { .. } => FacetKind::Label,
            EdgeFacet::Attrs { .. } => FacetKind::Attrs,
            EdgeFacet::Collapsed { .. } => FacetKind::Collapsed,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("kind", self.kind().as_str());
        match self {
            EdgeFacet::Retarget {
                end,
                from,
                to,
                cause,
            } => {
                out.insert("end", end.as_str());
                out.insert("from", from);
                out.insert("to", to);
                out.insert("cause", cause.as_str());
            }
            EdgeFacet::Predicate { from, to } | EdgeFacet::Label { from, to } => {
                out.insert("from", from);
                out.insert("to", to);
            }
            EdgeFacet::Attrs { changes } => {
                out.insert("changes", changes_value(changes));
            }
            EdgeFacet::Collapsed { into } => {
                out.insert("into", into);
            }
        }
        Value::Object(out)
    }
}

/// Degrees of a union node in each version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Degree {
    pub before: usize,
    pub after: usize,
}

/// A node of the union graph (`UnionNode`): `added` has only `after`, `removed` only `before`,
/// `unchanged` and `modified` both.
#[derive(Clone, Debug, PartialEq)]
pub struct UnionNode {
    pub id: UnionId,
    pub status: ChangeStatus,
    pub before_id: Option<Id>,
    pub after_id: Option<Id>,
    pub before: Option<Arc<KGNode>>,
    pub after: Option<Arc<KGNode>>,
    /// In canonical facet order.
    pub facets: Vec<NodeFacet>,
    /// The hunk this node's change belongs to; unchanged nodes have none.
    pub hunk: Option<JsStr>,
    /// `after.label ?? before.label`.
    pub label: JsStr,
    /// `after.types ?? before.types`.
    pub types: Vec<JsStr>,
    pub degree: Degree,
}

/// An edge of the union graph (`UnionEdge`).
#[derive(Clone, Debug, PartialEq)]
pub struct UnionEdge {
    pub id: UnionId,
    /// Endpoints in the after version (the before version for removed edges).
    pub source: UnionId,
    pub target: UnionId,
    pub predicate: JsStr,
    pub label: JsStr,
    pub status: ChangeStatus,
    pub facets: Vec<EdgeFacet>,
    pub hunk: Option<JsStr>,
    /// The predicate is a hierarchy predicate.
    pub hierarchical: bool,
    pub before_key: Option<EdgeKey>,
    pub after_key: Option<EdgeKey>,
    pub before: Option<Arc<KGEdge>>,
    pub after: Option<Arc<KGEdge>>,
    /// Present only when the before-version endpoint differs.
    pub source_before: Option<UnionId>,
    pub target_before: Option<UnionId>,
    /// Present only when the predicate changed.
    pub predicate_before: Option<JsStr>,
    /// The delta can update the paired edge in place (pipeline only, not serialized).
    pub(crate) in_place: bool,
}

/// `add`, `remove`, `merge`, `split`, `modify` or `relations`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HunkKind {
    Add,
    Remove,
    Merge,
    Split,
    Modify,
    Relations,
}

impl HunkKind {
    /// `HUNK_KINDS` (the order of `stats.hunks`).
    pub const ALL: [HunkKind; 6] = [
        HunkKind::Add,
        HunkKind::Remove,
        HunkKind::Merge,
        HunkKind::Split,
        HunkKind::Modify,
        HunkKind::Relations,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HunkKind::Add => "add",
            HunkKind::Remove => "remove",
            HunkKind::Merge => "merge",
            HunkKind::Split => "split",
            HunkKind::Modify => "modify",
            HunkKind::Relations => "relations",
        }
    }

    pub fn from_name(name: &str) -> Option<HunkKind> {
        HunkKind::ALL.into_iter().find(|k| k.as_str() == name)
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Replay order: clean up, restructure, refine, grow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ReplayPhase {
    Remove,
    Restructure,
    Modify,
    Add,
}

impl ReplayPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            ReplayPhase::Remove => "remove",
            ReplayPhase::Restructure => "restructure",
            ReplayPhase::Modify => "modify",
            ReplayPhase::Add => "add",
        }
    }

    pub fn from_name(name: &str) -> Option<ReplayPhase> {
        [
            ReplayPhase::Remove,
            ReplayPhase::Restructure,
            ReplayPhase::Modify,
            ReplayPhase::Add,
        ]
        .into_iter()
        .find(|p| p.as_str() == name)
    }
}

/// Added, removed and modified counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CountTriplet {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
}

impl CountTriplet {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("added", self.added);
        out.insert("removed", self.removed);
        out.insert("modified", self.modified);
        Value::Object(out)
    }
}

/// What a hunk owns, counted.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct HunkSummary {
    pub nodes: CountTriplet,
    pub edges: CountTriplet,
    /// Distinct facet kinds in the hunk, in canonical order.
    pub facets: Vec<FacetKind>,
}

impl HunkSummary {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("nodes", self.nodes.to_value());
        out.insert("edges", self.edges.to_value());
        out.insert(
            "facets",
            Value::Array(
                self.facets
                    .iter()
                    .map(|k| Value::from(k.as_str()))
                    .collect(),
            ),
        );
        Value::Object(out)
    }
}

/// A review unit: a partition of the changed union elements (`Hunk`).
#[derive(Clone, Debug, PartialEq)]
pub struct Hunk {
    /// `${kind}:${anchor}` (plus `#n` on a collision).
    pub id: JsStr,
    pub kind: HunkKind,
    pub phase: ReplayPhase,
    pub anchor: UnionId,
    /// Changed nodes owned by the hunk (sorted, anchor first).
    pub nodes: Vec<UnionId>,
    /// Changed edges owned by the hunk (sorted).
    pub edges: Vec<UnionId>,
    /// Nodes needed to read the hunk that it does not own (sorted).
    pub context: Vec<UnionId>,
    /// Indices into `delta.ops` (ascending).
    pub ops: Vec<usize>,
    /// Ids of the hunks to apply first (sorted).
    pub requires: Vec<JsStr>,
    pub summary: HunkSummary,
    /// Default review order, 0-based and dense.
    pub order: usize,
}

impl Hunk {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("id", &self.id);
        out.insert("kind", self.kind.as_str());
        out.insert("phase", self.phase.as_str());
        out.insert("anchor", &self.anchor);
        out.insert("nodes", strings(&self.nodes));
        out.insert("edges", strings(&self.edges));
        out.insert("context", strings(&self.context));
        out.insert(
            "ops",
            Value::Array(self.ops.iter().map(|&i| Value::from(i)).collect()),
        );
        out.insert("requires", strings(&self.requires));
        out.insert("summary", self.summary.to_value());
        out.insert("order", self.order);
        Value::Object(out)
    }
}

/// `id`, `hint` or `similarity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MatchMethod {
    Id,
    Hint,
    Similarity,
}

impl MatchMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchMethod::Id => "id",
            MatchMethod::Hint => "hint",
            MatchMethod::Similarity => "similarity",
        }
    }
}

/// Per-signal similarity breakdown, each in [0, 1]; missing signals are 0.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct MatchEvidence {
    pub label: f64,
    pub neighbors: f64,
    pub types: f64,
    pub attrs: f64,
}

impl MatchEvidence {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("label", self.label);
        out.insert("neighbors", self.neighbors);
        out.insert("types", self.types);
        out.insert("attrs", self.attrs);
        Value::Object(out)
    }
}

/// An accepted match.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeMatch {
    pub before: Id,
    pub after: Id,
    pub method: MatchMethod,
    /// 1 for id and hint matches.
    pub score: f64,
    pub evidence: Option<MatchEvidence>,
}

impl NodeMatch {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("before", &self.before);
        out.insert("after", &self.after);
        out.insert("method", self.method.as_str());
        out.insert("score", self.score);
        if let Some(evidence) = &self.evidence {
            out.insert("evidence", evidence.to_value());
        }
        Value::Object(out)
    }
}

/// Why a suggestion was not applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SuggestionReason {
    BelowThreshold,
    Ambiguous,
}

impl SuggestionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionReason::BelowThreshold => "below-threshold",
            SuggestionReason::Ambiguous => "ambiguous",
        }
    }
}

/// A plausible pairing that was not applied.
#[derive(Clone, Debug, PartialEq)]
pub struct MatchSuggestion {
    pub before: Id,
    pub after: Id,
    pub score: f64,
    pub evidence: MatchEvidence,
    pub reason: SuggestionReason,
}

impl MatchSuggestion {
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("before", &self.before);
        out.insert("after", &self.after);
        out.insert("score", self.score);
        out.insert("evidence", self.evidence.to_value());
        out.insert("reason", self.reason.as_str());
        Value::Object(out)
    }
}

/// Counts of a kind of element by status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CountDelta {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub unchanged: usize,
}

impl CountDelta {
    pub fn changes(&self) -> usize {
        self.added + self.removed + self.modified
    }

    pub fn add(&mut self, status: ChangeStatus) {
        match status {
            ChangeStatus::Added => self.added += 1,
            ChangeStatus::Removed => self.removed += 1,
            ChangeStatus::Modified => self.modified += 1,
            ChangeStatus::Unchanged => self.unchanged += 1,
        }
    }

    fn insert_into(&self, out: &mut Object) {
        out.insert("added", self.added);
        out.insert("removed", self.removed);
        out.insert("modified", self.modified);
        out.insert("unchanged", self.unchanged);
    }

    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        self.insert_into(&mut out);
        Value::Object(out)
    }
}

/// Counts per node type.
#[derive(Clone, Debug, PartialEq)]
pub struct TypeStat {
    pub r#type: JsStr,
    pub counts: CountDelta,
}

/// Diff statistics (docs/algorithms.md §9).
#[derive(Clone, Debug, PartialEq)]
pub struct DiffStats {
    pub nodes: CountDelta,
    pub edges: CountDelta,
    /// Nodes and edges of the before version.
    pub before: (usize, usize),
    pub after: (usize, usize),
    /// Union elements carrying each facet kind, in `FacetKind::ALL` order.
    pub facets: [usize; 16],
    /// Hunks of each kind, in `HunkKind::ALL` order.
    pub hunks: [usize; 6],
    /// Sorted by total changes (descending), then type.
    pub by_type: Vec<TypeStat>,
    pub identical: bool,
}

impl DiffStats {
    pub fn to_value(&self) -> Value {
        let size = |(nodes, edges): (usize, usize)| {
            let mut out = Object::new();
            out.insert("nodes", nodes);
            out.insert("edges", edges);
            Value::Object(out)
        };
        let mut facets = Object::new();
        for kind in FacetKind::ALL {
            facets.insert(kind.as_str(), self.facets[kind.index()]);
        }
        let mut hunks = Object::new();
        for kind in HunkKind::ALL {
            hunks.insert(kind.as_str(), self.hunks[kind.index()]);
        }
        let by_type = self
            .by_type
            .iter()
            .map(|t| {
                let mut out = Object::new();
                out.insert("type", &t.r#type);
                t.counts.insert_into(&mut out);
                Value::Object(out)
            })
            .collect();
        let mut out = Object::new();
        out.insert("nodes", self.nodes.to_value());
        out.insert("edges", self.edges.to_value());
        out.insert("before", size(self.before));
        out.insert("after", size(self.after));
        out.insert("facets", facets);
        out.insert("hunks", hunks);
        out.insert("byType", Value::Array(by_type));
        out.insert("identical", self.identical);
        Value::Object(out)
    }
}
