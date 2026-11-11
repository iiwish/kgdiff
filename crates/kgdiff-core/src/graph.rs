//! The normalized graph (`KGraph` and its parts in `types.ts`), in a compact representation.
//!
//! A graph is read through methods: its fields are private, so that the representation can change
//! without changing the callers. Nodes are shared records, small because what few nodes have
//! lives apart from them. Edges are not records at all: they are rows of positions, into the nodes
//! for their ends and into one table of text for their predicates and labels, and the structural
//! key of an edge is written from its row when it is asked for. [`EdgeRef`] reads a row;
//! [`KGEdge`] is an edge on its own, as a diff or a delta holds one.

use std::hash::BuildHasher as _;
use std::sync::{Arc, OnceLock};

use crate::canonical::{triple_key_in, write_triple_key};
use crate::js::{BuildHasher, IndexMap, JsStr, Object};
use crate::model::{Attrs, EdgeIdentity, EdgeKey, GraphIssue, Id, Point};

/// What few nodes have, kept apart so that a typical node stays small.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct RareFields {
    aliases: Vec<JsStr>,
    replaces: Vec<Id>,
    replaced_by: Vec<Id>,
    position: Option<Point>,
}

/// A normalized node. Its fields are read through methods.
#[derive(Clone, Debug, PartialEq)]
pub struct KGNode {
    pub(crate) id: Id,
    pub(crate) label: JsStr,
    pub(crate) types: Box<[JsStr]>,
    pub(crate) attrs: Attrs,
    pub(crate) rare: Option<Box<RareFields>>,
    pub(crate) deprecated: bool,
    pub(crate) implicit: bool,
}

/// The fields of a node, to build one or to change some.
#[derive(Clone, Debug, Default)]
pub(crate) struct NodeParts {
    pub id: Id,
    pub label: JsStr,
    pub types: Vec<JsStr>,
    pub aliases: Vec<JsStr>,
    pub attrs: Attrs,
    pub deprecated: bool,
    pub replaces: Vec<Id>,
    pub replaced_by: Vec<Id>,
    pub implicit: bool,
    pub position: Option<Point>,
}

impl KGNode {
    pub(crate) fn from_parts(parts: NodeParts) -> KGNode {
        let is_rare = !parts.aliases.is_empty()
            || !parts.replaces.is_empty()
            || !parts.replaced_by.is_empty()
            || parts.position.is_some();
        KGNode {
            id: parts.id,
            label: parts.label,
            types: parts.types.into_boxed_slice(),
            attrs: parts.attrs,
            rare: is_rare.then(|| {
                Box::new(RareFields {
                    aliases: parts.aliases,
                    replaces: parts.replaces,
                    replaced_by: parts.replaced_by,
                    position: parts.position,
                })
            }),
            deprecated: parts.deprecated,
            implicit: parts.implicit,
        }
    }

    pub(crate) fn to_parts(&self) -> NodeParts {
        NodeParts {
            id: self.id.clone(),
            label: self.label.clone(),
            types: self.types.to_vec(),
            aliases: self.aliases().to_vec(),
            attrs: self.attrs.clone(),
            deprecated: self.deprecated,
            replaces: self.replaces().to_vec(),
            replaced_by: self.replaced_by().to_vec(),
            implicit: self.implicit,
            position: self.position(),
        }
    }

    pub fn id(&self) -> &Id {
        &self.id
    }

    /// Never empty: falls back to the id.
    pub fn label(&self) -> &JsStr {
        &self.label
    }

    /// Sorted, unique.
    pub fn types(&self) -> &[JsStr] {
        &self.types
    }

    /// Sorted, unique, never contains the label.
    pub fn aliases(&self) -> &[JsStr] {
        self.rare.as_ref().map_or(&[], |r| &r.aliases)
    }

    pub fn attrs(&self) -> &Attrs {
        &self.attrs
    }

    pub fn is_deprecated(&self) -> bool {
        self.deprecated
    }

    /// Sorted, unique.
    pub fn replaces(&self) -> &[Id] {
        self.rare.as_ref().map_or(&[], |r| &r.replaces)
    }

    /// Sorted, unique.
    pub fn replaced_by(&self) -> &[Id] {
        self.rare.as_ref().map_or(&[], |r| &r.replaced_by)
    }

    /// Created implicitly for a dangling edge endpoint.
    pub fn is_implicit(&self) -> bool {
        self.implicit
    }

    /// The pinned layout position.
    pub fn position(&self) -> Option<Point> {
        self.rare.as_ref().and_then(|r| r.position)
    }
}

/// A normalized edge on its own, as a diff or a delta holds one. An edge of a graph is read through
/// an [`EdgeRef`], and [`EdgeRef::to_edge`] makes one of these of it.
#[derive(Clone, Debug, PartialEq)]
pub struct KGEdge {
    pub(crate) key: EdgeKey,
    pub(crate) id: Option<Id>,
    pub(crate) source: Id,
    pub(crate) target: Id,
    pub(crate) predicate: JsStr,
    pub(crate) label: JsStr,
    pub(crate) attrs: Attrs,
}

impl KGEdge {
    /// The identity of the edge within its graph.
    pub fn key(&self) -> &EdgeKey {
        &self.key
    }

    pub fn id(&self) -> Option<&Id> {
        self.id.as_ref()
    }

    pub fn source(&self) -> &Id {
        &self.source
    }

    pub fn target(&self) -> &Id {
        &self.target
    }

    pub fn predicate(&self) -> &JsStr {
        &self.predicate
    }

    pub fn label(&self) -> &JsStr {
        &self.label
    }

    pub fn attrs(&self) -> &Attrs {
        &self.attrs
    }
}

/// One edge: positions of its ends among the nodes, of its predicate and label among the texts.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EdgeRow {
    pub source: u32,
    pub target: u32,
    pub predicate: u32,
    pub label: u32,
}

/// The edges of a graph, in edge order. Every row's ends are nodes of the graph.
#[derive(Clone, Debug, Default)]
pub(crate) struct EdgeTable {
    rows: Vec<EdgeRow>,
    /// Predicates and labels, each text once.
    texts: Vec<JsStr>,
    /// Empty, or the id of every row.
    ids: Vec<Option<Id>>,
    /// Empty, or the attributes of every row.
    attrs: Vec<Attrs>,
    /// By ascending row, the keys that are not what [`KGraph::derived_key`] writes (`#2`, …).
    keys: Vec<(u32, EdgeKey)>,
    /// What [`EdgeTable::attrs`] holds for a row without attributes.
    no_attrs: Attrs,
    /// By hash, the rows, for lookups by key. Built on first use.
    index: OnceLock<KeyIndex>,
}

/// What it takes to tell whether a key is the one a row derives.
pub(crate) struct KeyContext<'a> {
    pub nodes: &'a IndexMap<Id, Arc<KGNode>>,
    pub identity: EdgeIdentity,
    pub buffer: String,
}

/// An edge taken out of a table to be merged or moved.
#[derive(Clone, Debug)]
pub(crate) struct EdgeDraft {
    pub id: Option<Id>,
    pub attrs: Attrs,
    pub row: EdgeRow,
}

impl EdgeTable {
    /// A table with room for `rows` rows.
    pub(crate) fn with_capacity(rows: usize) -> Self {
        EdgeTable {
            rows: Vec::with_capacity(rows),
            ..EdgeTable::default()
        }
    }

    pub(crate) fn set_texts(&mut self, texts: Vec<JsStr>) {
        self.texts = texts;
    }

    pub(crate) fn take_texts(&mut self) -> Vec<JsStr> {
        std::mem::take(&mut self.texts)
    }

    pub(crate) fn rows(&self) -> &[EdgeRow] {
        &self.rows
    }

    pub(crate) fn id(&self, at: usize) -> Option<&Id> {
        self.ids.get(at)?.as_ref()
    }

    /// Adds a row whose key is the one it derives. The columns of ids and attributes exist from
    /// the first row that has one.
    pub(crate) fn push(&mut self, row: EdgeRow, id: Option<Id>, attrs: Attrs) {
        if id.is_some() || !self.ids.is_empty() {
            self.ids
                .reserve(self.rows.capacity().saturating_sub(self.ids.len()));
            self.ids.resize(self.rows.len(), None);
            self.ids.push(id);
        }
        if !attrs.is_empty() || !self.attrs.is_empty() {
            self.attrs
                .reserve(self.rows.capacity().saturating_sub(self.attrs.len()));
            self.attrs.resize(self.rows.len(), Attrs::default());
            self.attrs.push(attrs);
        }
        self.rows.push(row);
    }

    /// Adds an edge whose key is `key`, stored only if it is not the key the row derives.
    pub(crate) fn push_keyed(&mut self, keys: &mut KeyContext<'_>, edge: EdgeDraft, key: EdgeKey) {
        let derived = match (&edge.id, keys.identity) {
            (Some(id), EdgeIdentity::Id) => *id == key,
            _ => {
                let row = edge.row;
                let text = |at: u32| keys.nodes.get_index(position(at)).map_or("", |(id, _)| id);
                let predicate = &self.texts[position(row.predicate)];
                let (source, target) = (text(row.source), text(row.target));
                write_triple_key(&mut keys.buffer, source, predicate, target);
                keys.buffer.as_str() == key.as_str()
            }
        };
        if !derived {
            let at = u32::try_from(self.rows.len()).unwrap_or(u32::MAX);
            self.keys.push((at, key));
        }
        self.push(edge.row, edge.id, edge.attrs);
    }

    /// The row at `at` with its id and attributes, which leave the table.
    pub(crate) fn take_draft(&mut self, at: usize) -> EdgeDraft {
        EdgeDraft {
            id: self.ids.get_mut(at).and_then(Option::take),
            attrs: self
                .attrs
                .get_mut(at)
                .map(std::mem::take)
                .unwrap_or_default(),
            row: self.rows[at],
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.rows.len()
    }

    /// Gives back the room the table did not use.
    fn shrink(&mut self) {
        self.rows.shrink_to_fit();
        self.texts.shrink_to_fit();
        self.ids.shrink_to_fit();
        self.attrs.shrink_to_fit();
        self.keys.shrink_to_fit();
    }
}

fn position(at: u32) -> usize {
    usize::try_from(at).unwrap_or(usize::MAX)
}

/// Rows by a hash of their key, sorted, so that a key is found without any row holding its text.
/// Which rows share a hash changes nothing: a candidate's key is compared before it is taken.
#[derive(Clone, Debug, Default)]
struct KeyIndex {
    hasher: BuildHasher,
    by_hash: Vec<(u32, u32)>,
}

impl KeyIndex {
    fn hash(&self, key: &str) -> u32 {
        let wide = self.hasher.hash_one(key);
        u32::try_from(wide >> 32).unwrap_or(0)
    }
}

/// The edges at each node as positions in the edges, grouped by the node's position (compressed
/// rows), each list in edge order. Built once with the graph.
#[derive(Clone, Debug, Default)]
struct Adjacency {
    /// The edges of node `i` are `edges[starts[i]..starts[i + 1]]`.
    starts: Vec<u32>,
    edges: Vec<u32>,
}

impl Adjacency {
    /// The lists of `nodes` nodes from each edge's end, in edge order.
    fn build(nodes: usize, ends: impl Iterator<Item = u32> + Clone) -> Self {
        let mut starts = vec![0u32; nodes + 1];
        for at in ends.clone() {
            starts[position(at) + 1] += 1;
        }
        for i in 0..nodes {
            starts[i + 1] += starts[i];
        }
        let mut next = starts.clone();
        let mut edges = vec![0u32; position(starts[nodes])];
        for (edge, at) in (0u32..).zip(ends) {
            let slot = &mut next[position(at)];
            edges[position(*slot)] = edge;
            *slot += 1;
        }
        Adjacency { starts, edges }
    }

    fn of(&self, node: usize) -> &[u32] {
        match (self.starts.get(node), self.starts.get(node + 1)) {
            (Some(&from), Some(&to)) => &self.edges[position(from)..position(to)],
            _ => &[],
        }
    }
}

/// A normalized, indexed, immutable graph (`normalize`), read through methods. Nodes and edges
/// come in the order of their first declaration.
#[derive(Clone, Debug)]
pub struct KGraph {
    meta: Object,
    pub(crate) nodes: IndexMap<Id, Arc<KGNode>>,
    edges: EdgeTable,
    outgoing: Adjacency,
    incoming: Adjacency,
    edge_identity: EdgeIdentity,
    issues: Vec<GraphIssue>,
    /// `hash_graph`, computed once.
    pub(crate) hash: OnceLock<String>,
}

impl KGraph {
    /// The graph of indexed nodes and a filled table, with its adjacency (`indexGraph`).
    pub(crate) fn assemble(
        meta: Object,
        nodes: IndexMap<Id, Arc<KGNode>>,
        mut edges: EdgeTable,
        edge_identity: EdgeIdentity,
        issues: Vec<GraphIssue>,
    ) -> KGraph {
        edges.shrink();
        let outgoing = Adjacency::build(nodes.len(), edges.rows.iter().map(|row| row.source));
        let incoming = Adjacency::build(nodes.len(), edges.rows.iter().map(|row| row.target));
        KGraph {
            meta,
            nodes,
            edges,
            outgoing,
            incoming,
            edge_identity,
            issues,
            hash: OnceLock::new(),
        }
    }

    /// The `meta` object of the input.
    pub fn meta(&self) -> &Object {
        &self.meta
    }

    /// How edges are identified in this graph.
    pub fn edge_identity(&self) -> EdgeIdentity {
        self.edge_identity
    }

    /// What `normalize` repaired, sorted.
    pub fn issues(&self) -> &[GraphIssue] {
        &self.issues
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// The nodes, in node order.
    pub fn nodes(&self) -> impl ExactSizeIterator<Item = &KGNode> + DoubleEndedIterator {
        self.nodes.values().map(AsRef::as_ref)
    }

    /// The node `id`.
    pub fn node(&self, id: &str) -> Option<&KGNode> {
        self.nodes.get(id).map(AsRef::as_ref)
    }

    pub fn contains_node(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    /// The node at this position of [`KGraph::nodes`].
    pub fn node_at(&self, index: usize) -> Option<&KGNode> {
        self.nodes.get_index(index).map(|(_, node)| node.as_ref())
    }

    /// The position of the node `id` in [`KGraph::nodes`].
    pub fn node_index(&self, id: &str) -> Option<usize> {
        self.nodes.get_index_of(id)
    }

    /// The edges, in edge order.
    pub fn edges(&self) -> impl ExactSizeIterator<Item = EdgeRef<'_>> + DoubleEndedIterator {
        (0..self.edges.len()).map(|at| EdgeRef { graph: self, at })
    }

    /// The edge at this position of [`KGraph::edges`].
    pub fn edge_at(&self, index: usize) -> Option<EdgeRef<'_>> {
        (index < self.edges.len()).then_some(EdgeRef {
            graph: self,
            at: index,
        })
    }

    /// The edge with this key. The first lookup in a graph indexes its keys.
    pub fn edge(&self, key: &str) -> Option<EdgeRef<'_>> {
        self.edge_index(key).and_then(|at| self.edge_at(at))
    }

    pub fn contains_edge(&self, key: &str) -> bool {
        self.edge_index(key).is_some()
    }

    /// The position of the edge with this key in [`KGraph::edges`].
    pub fn edge_index(&self, key: &str) -> Option<usize> {
        let index = self.edges.index.get_or_init(|| self.index_keys());
        let hash = index.hash(key);
        let from = index.by_hash.partition_point(|&(h, _)| h < hash);
        index.by_hash[from..]
            .iter()
            .take_while(|&&(h, _)| h == hash)
            .map(|&(_, at)| position(at))
            .find(|&at| self.key_at(at).as_str() == key)
    }

    fn index_keys(&self) -> KeyIndex {
        let mut index = KeyIndex {
            hasher: BuildHasher::default(),
            by_hash: Vec::with_capacity(self.edges.len()),
        };
        for at in 0..self.edges.len() {
            let hash = index.hash(&self.key_at(at));
            index
                .by_hash
                .push((hash, u32::try_from(at).unwrap_or(u32::MAX)));
        }
        index.by_hash.sort_by_key(|&(hash, _)| hash);
        index
    }

    /// The edges leaving the node `id`, in edge order; none for an absent id.
    pub fn outgoing(&self, id: &str) -> impl Iterator<Item = EdgeRef<'_>> {
        self.edges_of(&self.outgoing, id)
    }

    /// The edges entering the node `id`, in edge order; none for an absent id.
    pub fn incoming(&self, id: &str) -> impl Iterator<Item = EdgeRef<'_>> {
        self.edges_of(&self.incoming, id)
    }

    /// [`outgoing`](KGraph::outgoing) or, with `out` false, [`incoming`](KGraph::incoming).
    pub(crate) fn adjacent(&self, id: &str, out: bool) -> impl Iterator<Item = EdgeRef<'_>> {
        self.edges_of(if out { &self.outgoing } else { &self.incoming }, id)
    }

    fn edges_of<'a>(
        &'a self,
        adjacency: &'a Adjacency,
        id: &str,
    ) -> impl Iterator<Item = EdgeRef<'a>> {
        let list = self
            .nodes
            .get_index_of(id)
            .map_or(&[][..], |at| adjacency.of(at));
        list.iter().map(|&at| EdgeRef {
            graph: self,
            at: position(at),
        })
    }

    /// The degree of the node at this position of [`KGraph::nodes`], without a lookup.
    pub fn degree_at(&self, index: usize) -> usize {
        self.outgoing.of(index).len() + self.incoming.of(index).len()
    }

    /// Number of edge ends at a node (a self-loop counts twice); 0 for an absent id (`degree`).
    pub fn degree(&self, id: Option<&str>) -> usize {
        id.and_then(|id| self.nodes.get_index_of(id))
            .map_or(0, |at| self.degree_at(at))
    }

    /// Every edge on its own, in edge order, for what compares two graphs or changes one.
    pub(crate) fn shared_edges(&self) -> Vec<Arc<KGEdge>> {
        let mut buffer = String::new();
        (0..self.edges.len())
            .map(|at| Arc::new(self.edge_on_its_own(at, &mut buffer)))
            .collect()
    }

    fn edge_on_its_own(&self, at: usize, buffer: &mut String) -> KGEdge {
        let edge = EdgeRef { graph: self, at };
        KGEdge {
            key: self.key_in(at, buffer),
            id: edge.id().cloned(),
            source: edge.source().clone(),
            target: edge.target().clone(),
            predicate: edge.predicate().clone(),
            label: edge.label().clone(),
            attrs: edge.attrs().clone(),
        }
    }

    fn node_id(&self, at: u32) -> &Id {
        match self.nodes.get_index(position(at)) {
            Some((id, _)) => id,
            None => unreachable!("every end of an edge is a node"),
        }
    }

    fn stored_key(&self, at: usize) -> Option<&EdgeKey> {
        if self.edges.keys.is_empty() {
            return None;
        }
        let wanted = u32::try_from(at).unwrap_or(u32::MAX);
        self.edges
            .keys
            .binary_search_by_key(&wanted, |(row, _)| *row)
            .ok()
            .map(|found| &self.edges.keys[found].1)
    }

    fn key_at(&self, at: usize) -> EdgeKey {
        self.key_in(at, &mut String::new())
    }

    /// The key of a row: stored if it is not the one the row derives, the edge's id under id
    /// identity, otherwise its structural key.
    fn key_in(&self, at: usize, buffer: &mut String) -> EdgeKey {
        if let Some(key) = self.stored_key(at) {
            return key.clone();
        }
        let edge = EdgeRef { graph: self, at };
        match edge.id() {
            Some(id) if self.edge_identity == EdgeIdentity::Id => id.clone(),
            _ => triple_key_in(buffer, edge.source(), edge.predicate(), edge.target()),
        }
    }
}

/// An edge of a graph, read in place. Copied freely; what it returns lives as long as the graph.
#[derive(Clone, Copy)]
pub struct EdgeRef<'g> {
    graph: &'g KGraph,
    at: usize,
}

impl<'g> EdgeRef<'g> {
    fn row(&self) -> &'g EdgeRow {
        &self.graph.edges.rows[self.at]
    }

    /// The position of the edge in [`KGraph::edges`].
    pub fn index(&self) -> usize {
        self.at
    }

    /// The identity of the edge within its graph. Most keys are written from the edge's triple
    /// when asked for, so this allocates: keep the result rather than asking twice.
    pub fn key(&self) -> EdgeKey {
        self.graph.key_at(self.at)
    }

    pub fn id(&self) -> Option<&'g Id> {
        self.graph.edges.ids.get(self.at)?.as_ref()
    }

    pub fn source(&self) -> &'g Id {
        self.graph.node_id(self.row().source)
    }

    pub fn target(&self) -> &'g Id {
        self.graph.node_id(self.row().target)
    }

    pub fn predicate(&self) -> &'g JsStr {
        &self.graph.edges.texts[position(self.row().predicate)]
    }

    pub fn label(&self) -> &'g JsStr {
        &self.graph.edges.texts[position(self.row().label)]
    }

    pub fn attrs(&self) -> &'g Attrs {
        self.graph
            .edges
            .attrs
            .get(self.at)
            .unwrap_or(&self.graph.edges.no_attrs)
    }

    /// The edge on its own, independent of the graph.
    pub fn to_edge(&self) -> KGEdge {
        self.graph.edge_on_its_own(self.at, &mut String::new())
    }
}

impl std::fmt::Debug for EdgeRef<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.to_edge().fmt(f)
    }
}
