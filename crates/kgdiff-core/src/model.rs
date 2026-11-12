//! The normalized graph and the vocabulary of a diff: statuses, facets, hunks, matches and
//! statistics.

use std::sync::Arc;

use crate::js::{JsStr, Object, Value};

pub use crate::graph::{EdgeRef, KGEdge, KGNode, KGraph};

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
    /// Horizontal coordinate.
    pub x: f64,
    /// Vertical coordinate.
    pub y: f64,
}

/// How edges are identified within a version and matched across versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum EdgeIdentity {
    /// An edge is its (source, predicate, target) triple.
    #[default]
    Structure,
    /// Edges carry stable ids (falling back to structure for edges without one).
    Id,
}

impl EdgeIdentity {
    /// The name used in kgdiff JSON (`"structure"` or `"id"`).
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeIdentity::Structure => "structure",
            EdgeIdentity::Id => "id",
        }
    }

    /// Parses a name written by [`EdgeIdentity::as_str`]; `None` for anything else.
    pub fn from_name(name: &str) -> Option<EdgeIdentity> {
        match name {
            "structure" => Some(EdgeIdentity::Structure),
            "id" => Some(EdgeIdentity::Id),
            _ => None,
        }
    }
}

/// Codes of the issues `normalize` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum GraphIssueCode {
    /// Two nodes carry the same id.
    DuplicateNode,
    /// An edge names an endpoint that is not a node.
    DanglingEdge,
    /// Several edges share one identity.
    DuplicateEdge,
    /// A node has an empty id and is dropped.
    EmptyId,
    /// An attribute value cannot be represented in JSON and was dropped or converted.
    InvalidAttr,
}

impl GraphIssueCode {
    /// The code as written in kgdiff JSON (for example `"duplicate-node"`).
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
#[non_exhaustive]
pub struct GraphIssue {
    /// What kind of repair this is.
    pub code: GraphIssueCode,
    /// A human-readable description.
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

// ─── The diff: the union graph ───────────────────────────────────────────────

fn strings(list: &[JsStr]) -> Value {
    Value::Array(list.iter().map(Value::from).collect())
}

/// `unchanged`, `added`, `removed` or `modified`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeStatus {
    /// Present in both versions and equal.
    Unchanged,
    /// Present only in the after version.
    Added,
    /// Present only in the before version.
    Removed,
    /// Present in both versions with at least one facet.
    Modified,
}

impl ChangeStatus {
    /// The name used in kgdiff JSON (`"unchanged"`, `"added"`, `"removed"` or `"modified"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeStatus::Unchanged => "unchanged",
            ChangeStatus::Added => "added",
            ChangeStatus::Removed => "removed",
            ChangeStatus::Modified => "modified",
        }
    }

    /// Parses a name written by [`ChangeStatus::as_str`]; `None` for anything else.
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
    /// The attribute key.
    pub key: JsStr,
    /// The value in the before version; `None` when the attribute was added.
    pub before: Option<AttrValue>,
    /// The value in the after version; `None` when the attribute was removed.
    pub after: Option<AttrValue>,
}

impl AttrChange {
    /// The change as `{ key, before?, after? }`, as kgdiff JSON writes it.
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
    /// Elements present in the after version only, sorted.
    pub added: Vec<JsStr>,
    /// Elements present in the before version only, sorted.
    pub removed: Vec<JsStr>,
}

impl SetChange {
    /// Whether nothing was added and nothing was removed.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }

    fn insert_into(&self, out: &mut Object) {
        out.insert("added", strings(&self.added));
        out.insert("removed", strings(&self.removed));
    }

    /// The change as `{ added, removed }`, as kgdiff JSON writes it.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        self.insert_into(&mut out);
        Value::Object(out)
    }
}

/// How a merge or split was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Via {
    /// An explicit replacement hint (`replaces` / `replacedBy`), confidence 1.
    Hint,
    /// Label similarity and edge carry-over.
    Heuristic,
}

impl Via {
    /// The name used in kgdiff JSON (`"hint"` or `"heuristic"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Hint => "hint",
            Via::Heuristic => "heuristic",
        }
    }
}

/// Why an edge endpoint changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Cause {
    /// The endpoint was changed by editing the edge.
    Edit,
    /// The endpoint's node was merged into another.
    Merge,
    /// The endpoint's node was split.
    Split,
    /// The endpoint's node was moved under another parent (hierarchy predicates).
    Move,
}

impl Cause {
    /// The name used in kgdiff JSON (`"edit"`, `"merge"`, `"split"` or `"move"`).
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
    /// The edge's source node.
    Source,
    /// The edge's target node.
    Target,
}

impl End {
    /// The name used in kgdiff JSON (`"source"` or `"target"`).
    pub fn as_str(self) -> &'static str {
        match self {
            End::Source => "source",
            End::Target => "target",
        }
    }
}

/// Every facet kind, in canonical facet order (`FACET_ORDER`, docs/algorithms.md §4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum FacetKind {
    /// The node's id changed (a hint or similarity match).
    Rekey,
    /// The node's label changed.
    Rename,
    /// The node was merged into another node.
    MergedInto,
    /// The node absorbed one or more merged nodes.
    MergeTarget,
    /// The node was split off from another node.
    SplitFrom,
    /// The node was split into several nodes.
    SplitInto,
    /// The node's parents changed under a hierarchy predicate.
    Move,
    /// The node's `deprecated` flag changed.
    Deprecate,
    /// The node's `replaces` or `replacedBy` changed.
    Replacement,
    /// The node's type set changed.
    Types,
    /// The node's alias set changed.
    Aliases,
    /// The node's attributes changed.
    Attrs,
    /// An edge endpoint was redirected to another node.
    Retarget,
    /// An edge's predicate changed.
    Predicate,
    /// An edge's label changed.
    Label,
    /// The edge was removed because a merge made it duplicate another edge.
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

    /// The name used in kgdiff JSON (for example `"mergedInto"`).
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

    /// Parses a name written by [`FacetKind::as_str`]; `None` for anything else.
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
#[non_exhaustive]
pub enum NodeFacet {
    #[non_exhaustive]
    /// The label changed.
    Rename {
        /// The label in the before version.
        from: JsStr,
        /// The label in the after version.
        to: JsStr,
    },
    #[non_exhaustive]
    /// The id changed.
    Rekey {
        /// The id in the before version.
        from: Id,
        /// The id in the after version.
        to: Id,
        /// The match score in [0, 1].
        score: f64,
    },
    /// The type set changed.
    Types(SetChange),
    /// The alias set changed.
    Aliases(SetChange),
    #[non_exhaustive]
    /// Attributes changed.
    Attrs {
        /// The changes, sorted by key.
        changes: Vec<AttrChange>,
    },
    /// Parents removed and added (union ids, sorted) under a hierarchy predicate.
    #[non_exhaustive]
    Move {
        /// The hierarchy predicate under which the parents changed.
        predicate: JsStr,
        /// Parents in the before version, as union ids.
        from: Vec<UnionId>,
        /// Parents in the after version, as union ids.
        to: Vec<UnionId>,
    },
    #[non_exhaustive]
    /// The `deprecated` flag changed.
    Deprecate {
        /// The flag in the after version.
        deprecated: bool,
    },
    #[non_exhaustive]
    /// `replaces` and `replacedBy` changed; a side that did not change is empty.
    Replacement {
        /// Changes to the ids this node replaces.
        replaces: SetChange,
        /// Changes to the ids this node is replaced by.
        replaced_by: SetChange,
    },
    #[non_exhaustive]
    /// The node was merged into another node.
    MergedInto {
        /// The union id of the node it was merged into.
        target: UnionId,
        /// Confidence in [0, 1]; 1 for a hint.
        confidence: f64,
        /// How the merge was found.
        via: Via,
    },
    #[non_exhaustive]
    /// The node absorbed one or more merged nodes.
    MergeTarget {
        /// The union ids of the merged nodes, sorted.
        sources: Vec<UnionId>,
    },
    #[non_exhaustive]
    /// The node was split off from another node.
    SplitFrom {
        /// The union id of the node it was split from.
        source: UnionId,
        /// Confidence in [0, 1]; 1 for a hint.
        confidence: f64,
        /// How the split was found.
        via: Via,
    },
    #[non_exhaustive]
    /// The node was split into several nodes.
    SplitInto {
        /// The union ids of the nodes it was split into, sorted.
        targets: Vec<UnionId>,
    },
}

impl NodeFacet {
    /// The kind of this facet.
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
#[non_exhaustive]
pub enum EdgeFacet {
    #[non_exhaustive]
    /// An endpoint was redirected.
    Retarget {
        /// Which end of the edge changed.
        end: End,
        /// The union id of the old endpoint.
        from: UnionId,
        /// The union id of the new endpoint.
        to: UnionId,
        /// Why the endpoint changed.
        cause: Cause,
    },
    /// The predicate changed.
    #[non_exhaustive]
    Predicate {
        /// The predicate in the before version.
        from: JsStr,
        /// The predicate in the after version.
        to: JsStr,
    },
    /// The label changed.
    #[non_exhaustive]
    Label {
        /// The label in the before version.
        from: JsStr,
        /// The label in the after version.
        to: JsStr,
    },
    /// Attributes changed.
    #[non_exhaustive]
    Attrs {
        /// The changes, sorted by key.
        changes: Vec<AttrChange>,
    },
    /// Removed because, after a merge, it would duplicate the union edge `into`.
    #[non_exhaustive]
    Collapsed {
        /// The union id of the edge it duplicates.
        into: UnionId,
    },
}

impl EdgeFacet {
    /// The kind of this facet.
    pub fn kind(&self) -> FacetKind {
        match self {
            EdgeFacet::Retarget { .. } => FacetKind::Retarget,
            EdgeFacet::Predicate { .. } => FacetKind::Predicate,
            EdgeFacet::Label { .. } => FacetKind::Label,
            EdgeFacet::Attrs { .. } => FacetKind::Attrs,
            EdgeFacet::Collapsed { .. } => FacetKind::Collapsed,
        }
    }

    /// The facet as kgdiff JSON writes it.
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
    /// Degree in the before version (0 if the node does not exist there).
    pub before: usize,
    /// Degree in the after version (0 if the node does not exist there).
    pub after: usize,
}

/// A node of the union graph (`UnionNode`): `added` has only `after`, `removed` only `before`,
/// `unchanged` and `modified` both.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct UnionNode {
    /// The union id: the after id, else the before id.
    pub id: UnionId,
    /// Whether the node was added, removed, modified or left alone.
    pub status: ChangeStatus,
    /// The node's id in the before version, if it exists there.
    pub before_id: Option<Id>,
    /// The node's id in the after version, if it exists there.
    pub after_id: Option<Id>,
    /// The node in the before version.
    pub before: Option<Arc<KGNode>>,
    /// The node in the after version.
    pub after: Option<Arc<KGNode>>,
    /// In canonical facet order.
    pub facets: Vec<NodeFacet>,
    /// The hunk this node's change belongs to; unchanged nodes have none.
    pub hunk: Option<JsStr>,
    /// `after.label ?? before.label`.
    pub label: JsStr,
    /// The node's degree in each version.
    pub degree: Degree,
}

impl UnionNode {
    /// `after.types ?? before.types`.
    pub fn types(&self) -> &[JsStr] {
        self.after
            .as_ref()
            .or(self.before.as_ref())
            .map_or(&[], |n| n.types())
    }
}

/// An edge of the union graph (`UnionEdge`).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct UnionEdge {
    /// The union id, computed from the union endpoints.
    pub id: UnionId,
    /// Endpoints in the after version (the before version for removed edges).
    pub source: UnionId,
    /// The target's union id (the before target for removed edges).
    pub target: UnionId,
    /// The predicate in the after version (the before version for removed edges).
    pub predicate: JsStr,
    /// The edge label, defaulting to the predicate's readable form.
    pub label: JsStr,
    /// Whether the edge was added, removed, modified or left alone.
    pub status: ChangeStatus,
    /// The edge's semantic changes, in canonical facet order.
    pub facets: Vec<EdgeFacet>,
    /// The hunk this edge's change belongs to; unchanged edges have none.
    pub hunk: Option<JsStr>,
    /// The predicate is a hierarchy predicate.
    pub hierarchical: bool,
    /// The edge's key in the before version, if it exists there.
    pub before_key: Option<EdgeKey>,
    /// The edge's key in the after version, if it exists there.
    pub after_key: Option<EdgeKey>,
    /// The edge in the before version.
    pub before: Option<Arc<KGEdge>>,
    /// The edge in the after version.
    pub after: Option<Arc<KGEdge>>,
    /// Present only when the before-version endpoint differs.
    pub source_before: Option<UnionId>,
    /// Present only when the before-version endpoint differs.
    pub target_before: Option<UnionId>,
    /// Present only when the predicate changed.
    pub predicate_before: Option<JsStr>,
    /// The delta can update the paired edge in place (pipeline only, not serialized).
    pub(crate) in_place: bool,
}

/// `add`, `remove`, `merge`, `split`, `modify` or `relations`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HunkKind {
    /// Added nodes and their edges.
    Add,
    /// Removed nodes and their edges.
    Remove,
    /// Several nodes merged into one.
    Merge,
    /// One node split into several.
    Split,
    /// A changed node and the edges it is the subject of.
    Modify,
    /// Changed edges grouped by their source node.
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

    /// The name used in kgdiff JSON (for example `"relations"`).
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

    /// Parses a name written by [`HunkKind::as_str`]; `None` for anything else.
    pub fn from_name(name: &str) -> Option<HunkKind> {
        HunkKind::ALL.into_iter().find(|k| k.as_str() == name)
    }

    /// Position in [`HunkKind::ALL`].
    pub fn index(self) -> usize {
        self as usize
    }
}

/// Replay order: clean up, restructure, refine, grow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ReplayPhase {
    /// Removals, applied first.
    Remove,
    /// Merges, splits and relation changes.
    Restructure,
    /// Changes to existing nodes.
    Modify,
    /// Additions, applied last.
    Add,
}

impl ReplayPhase {
    /// The name used in kgdiff JSON (`"remove"`, `"restructure"`, `"modify"` or `"add"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ReplayPhase::Remove => "remove",
            ReplayPhase::Restructure => "restructure",
            ReplayPhase::Modify => "modify",
            ReplayPhase::Add => "add",
        }
    }

    /// Parses a name written by [`ReplayPhase::as_str`]; `None` for anything else.
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
    /// Number of elements added.
    pub added: usize,
    /// Number of elements removed.
    pub removed: usize,
    /// Number of elements modified.
    pub modified: usize,
}

impl CountTriplet {
    /// The counts as `{ added, removed, modified }`, as kgdiff JSON writes it.
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
#[non_exhaustive]
pub struct HunkSummary {
    /// Counts of nodes the hunk owns.
    pub nodes: CountTriplet,
    /// Counts of edges the hunk owns.
    pub edges: CountTriplet,
    /// Distinct facet kinds in the hunk, in canonical order.
    pub facets: Vec<FacetKind>,
}

impl HunkSummary {
    /// The summary as kgdiff JSON writes it.
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
#[non_exhaustive]
pub struct Hunk {
    /// `${kind}:${anchor}`, unique in a diff. It depends on the kind and the anchor only: the
    /// same two graphs and options give the same ids, and the id says where the hunk is, not
    /// what it holds. A contract from 0.9: docs/algorithms.md §7, "Hunk ids", says which edits
    /// leave ids alone, which ones group the changes again under other ids, and how to store
    /// review progress under an id. Read `kind` and `anchor` instead of parsing the id, since
    /// node ids may contain `:`.
    pub id: JsStr,
    /// What kind of change the hunk groups.
    pub kind: HunkKind,
    /// When the hunk is replayed relative to others.
    pub phase: ReplayPhase,
    /// The union id the hunk is anchored on.
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
    /// Counts of what the hunk owns.
    pub summary: HunkSummary,
    /// Default review order, 0-based and dense.
    pub order: usize,
}

impl Hunk {
    /// The hunk as kgdiff JSON writes it.
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
#[non_exhaustive]
pub enum MatchMethod {
    /// Equal ids.
    Id,
    /// A replacement hint.
    Hint,
    /// Label, neighbour, type and attribute similarity.
    Similarity,
}

impl MatchMethod {
    /// The name used in kgdiff JSON (`"id"`, `"hint"` or `"similarity"`).
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
#[non_exhaustive]
pub struct MatchEvidence {
    /// Label similarity.
    pub label: f64,
    /// Similarity of the matched neighbours.
    pub neighbors: f64,
    /// Type-set similarity.
    pub types: f64,
    /// Attribute similarity.
    pub attrs: f64,
}

impl MatchEvidence {
    /// The evidence as `{ label, neighbors, types, attrs }`, as kgdiff JSON writes it.
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
#[non_exhaustive]
pub struct NodeMatch {
    /// The node's id in the before version.
    pub before: Id,
    /// The node's id in the after version.
    pub after: Id,
    /// How the pair was matched.
    pub method: MatchMethod,
    /// 1 for id and hint matches.
    pub score: f64,
    /// The similarity breakdown; absent for id and hint matches.
    pub evidence: Option<MatchEvidence>,
}

impl NodeMatch {
    /// The match as kgdiff JSON writes it.
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
    /// The score is below the match threshold but above the suggestion threshold.
    BelowThreshold,
    /// The pair leads a rival by less than the required margin.
    Ambiguous,
}

impl SuggestionReason {
    /// The name used in kgdiff JSON (`"below-threshold"` or `"ambiguous"`).
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionReason::BelowThreshold => "below-threshold",
            SuggestionReason::Ambiguous => "ambiguous",
        }
    }
}

/// A plausible pairing that was not applied.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct MatchSuggestion {
    /// The before node's id.
    pub before: Id,
    /// The after node's id.
    pub after: Id,
    /// The similarity score in [0, 1].
    pub score: f64,
    /// The similarity breakdown behind the score.
    pub evidence: MatchEvidence,
    /// Why the pair was not matched.
    pub reason: SuggestionReason,
}

impl MatchSuggestion {
    /// The suggestion as kgdiff JSON writes it.
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
    /// Number of elements added.
    pub added: usize,
    /// Number of elements removed.
    pub removed: usize,
    /// Number of elements modified.
    pub modified: usize,
    /// Number of elements left alone.
    pub unchanged: usize,
}

impl CountDelta {
    /// Added + removed + modified.
    pub fn changes(&self) -> usize {
        self.added + self.removed + self.modified
    }

    /// Counts one element of the given status.
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

    /// The counts as `{ added, removed, modified, unchanged }`, as kgdiff JSON writes it.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        self.insert_into(&mut out);
        Value::Object(out)
    }
}

/// Counts per node type.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct TypeStat {
    /// The type.
    pub r#type: JsStr,
    /// Counts of the nodes with that type.
    pub counts: CountDelta,
}

/// Diff statistics (docs/algorithms.md §9).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct DiffStats {
    /// Node counts by status.
    pub nodes: CountDelta,
    /// Edge counts by status.
    pub edges: CountDelta,
    /// Nodes and edges of the before version.
    pub before: (usize, usize),
    /// Nodes and edges of the after version.
    pub after: (usize, usize),
    /// Union elements carrying each facet kind, in `FacetKind::ALL` order.
    pub facets: [usize; 16],
    /// Hunks of each kind, in `HunkKind::ALL` order.
    pub hunks: [usize; 6],
    /// Sorted by total changes (descending), then type.
    pub by_type: Vec<TypeStat>,
    /// Whether both versions are identical (nothing added, removed or modified).
    pub identical: bool,
}

impl DiffStats {
    /// The statistics as kgdiff JSON writes it.
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
