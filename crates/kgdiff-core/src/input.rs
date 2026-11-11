//! A graph as Rust values, for [`normalize_input`](crate::normalize_input): the members of
//! `graph.v1.json`, typed. Attribute values stay [`Value`]s, because their numbers, key order and
//! canonical form are JavaScript's.

use crate::js::{JsStr, Object, Value};
use crate::model::{Attrs, Id, Point};

/// A graph to normalize. `to_value` is the kgdiff JSON it stands for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GraphInput {
    pub meta: Object,
    pub nodes: Vec<NodeInput>,
    pub edges: Vec<EdgeInput>,
}

/// A node declaration. Everything but the id may be left to its default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NodeInput {
    /// Dropped with an `empty-id` issue when empty.
    pub id: Id,
    /// Defaults to the id.
    pub label: Option<JsStr>,
    pub types: Vec<JsStr>,
    pub aliases: Vec<JsStr>,
    pub attrs: Attrs,
    pub deprecated: bool,
    pub replaces: Vec<Id>,
    pub replaced_by: Vec<Id>,
    /// Written for a node created at an edge end the graph does not describe.
    pub implicit: bool,
    /// A pinned layout position; one that is not finite counts as none.
    pub position: Option<Point>,
}

/// An edge declaration. Everything but the ends may be left to its default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EdgeInput {
    /// A stable id, the edge's key under id identity.
    pub id: Option<Id>,
    pub source: Id,
    pub target: Id,
    pub predicate: JsStr,
    /// Defaults to a label made from the predicate.
    pub label: Option<JsStr>,
    pub attrs: Attrs,
}

impl NodeInput {
    /// A node with this id and defaults for the rest.
    pub fn new(id: impl Into<Id>) -> NodeInput {
        NodeInput {
            id: id.into(),
            ..NodeInput::default()
        }
    }

    /// The node as kgdiff JSON.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        out.insert("id", &self.id);
        if let Some(label) = &self.label {
            out.insert("label", label);
        }
        insert_list(&mut out, "types", &self.types);
        insert_list(&mut out, "aliases", &self.aliases);
        if !self.attrs.is_empty() {
            out.insert("attrs", self.attrs.clone());
        }
        if self.deprecated {
            out.insert("deprecated", true);
        }
        insert_list(&mut out, "replaces", &self.replaces);
        insert_list(&mut out, "replacedBy", &self.replaced_by);
        if self.implicit {
            out.insert("implicit", true);
        }
        if let Some(point) = self.position {
            let mut position = Object::new();
            position.insert("x", point.x);
            position.insert("y", point.y);
            out.insert("position", position);
        }
        Value::Object(out)
    }
}

impl EdgeInput {
    /// An edge between these ends and defaults for the rest.
    pub fn new(
        source: impl Into<Id>,
        predicate: impl Into<JsStr>,
        target: impl Into<Id>,
    ) -> EdgeInput {
        EdgeInput {
            source: source.into(),
            predicate: predicate.into(),
            target: target.into(),
            ..EdgeInput::default()
        }
    }

    /// The edge as kgdiff JSON.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        if let Some(id) = &self.id {
            out.insert("id", id);
        }
        out.insert("source", &self.source);
        out.insert("target", &self.target);
        out.insert("predicate", &self.predicate);
        if let Some(label) = &self.label {
            out.insert("label", label);
        }
        if !self.attrs.is_empty() {
            out.insert("attrs", self.attrs.clone());
        }
        Value::Object(out)
    }
}

impl GraphInput {
    /// The graph as kgdiff JSON, which [`normalize`](crate::normalize) makes the same graph of.
    pub fn to_value(&self) -> Value {
        let mut out = Object::new();
        if !self.meta.is_empty() {
            out.insert("meta", self.meta.clone());
        }
        out.insert(
            "nodes",
            Value::Array(self.nodes.iter().map(NodeInput::to_value).collect()),
        );
        out.insert(
            "edges",
            Value::Array(self.edges.iter().map(EdgeInput::to_value).collect()),
        );
        Value::Object(out)
    }
}

fn insert_list(out: &mut Object, key: &str, list: &[JsStr]) {
    if !list.is_empty() {
        out.insert(key, Value::Array(list.iter().map(Value::from).collect()));
    }
}
