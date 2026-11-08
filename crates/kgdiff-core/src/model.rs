//! The normalized graph (`KGraph` and its parts in `types.ts`).

use std::sync::{Arc, OnceLock};

use indexmap::IndexMap;

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
