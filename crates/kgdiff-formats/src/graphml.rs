//! GraphML, as NetworkX, igraph, yEd, Gephi and LightRAG write it.
//!
//! The document is read into node-link data, the JSON shape NetworkX's `node_link_data` gives
//! the same graph, and mapped by the JSON reader. So one graph saved as GraphML and as
//! node-link JSON is the same graph to kgdiff, and a field means the same in both: `label`,
//! `name` or `title` is the label, `type` the type, and so on (`docs/formats.md`).
//!
//! - `<node id>` is the node id; `<edge source target>` an edge, `<edge id>` its id.
//! - `<data key>` is a field, named by its key's `attr.name` and typed by `attr.type`: `int`,
//!   `long`, `float` and `double` are numbers, `boolean` a boolean, everything else text. A
//!   value that is not of its type stays text, with a warning. A key's `<default>` is the value
//!   of every element of its domain that has no `<data>` for it.
//! - A directed edge keeps its ends as written. An undirected one (`edgedefault="undirected"`,
//!   or `directed="false"` on the edge) has them in code unit order, so that `a - b` and
//!   `b - a` are one edge: a library writes them in the order it met the nodes.
//! - Edge ids that two edges share are not ids (NetworkX writes the keys of a multigraph's
//!   parallel edges there, which start at 0 for every pair of nodes): they are dropped.
//! - Nested graphs and further `<graph>` elements are merged into one graph; `<hyperedge>` and
//!   `<port>` are skipped; `<data>` with XML content (the drawing data of yEd) is dropped,
//!   except the text of yEd's first node or edge label, which is the element's label. Each with
//!   a warning.
//! - The defaults of the keys may add as many fields as the input has bytes (a million for a
//!   small one); a document whose defaults add more is refused, like an entity that expands
//!   without end.
//!
//! Nothing is fetched: the XML parser never loads external entities.

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{self, IndexMap, IndexSet, Object, Value};

use crate::ParseWarningCode;
use crate::shared::{
    Warnings, compare_strings, invalid_input_with, plural, strip_bom, typed_value,
};
use crate::xml::{XmlElement, XmlError, XmlHandler, is_xml_space, line_of, parse_xml, syntax};

const GRAPHML_NS: &str = "http://graphml.graphdrawing.org/xmlns";

/// `attr.type` of a key.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Type {
    Text,
    Integer,
    Decimal,
    Boolean,
}

impl Type {
    fn of(name: Option<&str>) -> Type {
        match name {
            Some("int" | "long") => Type::Integer,
            Some("float" | "double") => Type::Decimal,
            Some("boolean") => Type::Boolean,
            _ => Type::Text,
        }
    }
}

/// What a key's `for` names.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Domain {
    All,
    Graph,
    Node,
    Edge,
    /// `graphml`, `hyperedge`, `port`, `endpoint`: nothing kgdiff reads.
    Other,
}

struct Key {
    /// `attr.name`; a key without one is named by its id.
    name: String,
    r#type: Type,
    domain: Domain,
    default: Option<String>,
}

/// A `<data>` element with text content.
struct Data {
    key: String,
    text: String,
}

#[derive(Default)]
struct Node {
    id: String,
    data: Vec<Data>,
    /// The text of yEd's first `<y:NodeLabel>`.
    label: Option<String>,
}

#[derive(Default)]
struct Edge {
    id: Option<String>,
    source: String,
    target: String,
    undirected: bool,
    data: Vec<Data>,
    /// The text of yEd's first `<y:EdgeLabel>`.
    label: Option<String>,
}

/// Where a `<data>` belongs.
#[derive(Clone, Copy)]
enum Owner {
    Graph,
    Node(usize),
    Edge(usize),
    /// A graph merged into the first: its own data is not the graph's.
    Nobody,
}

enum Frame {
    Root,
    Key(String),
    Default {
        key: String,
        text: String,
    },
    /// `first`: the graph whose data is the graph's. `undirected`: its `edgedefault`.
    Graph {
        first: bool,
        undirected: bool,
    },
    Node(usize),
    Edge(usize),
    Data {
        owner: Owner,
        key: String,
        text: String,
        /// Whether it has child elements.
        structured: bool,
    },
    /// An element inside a `<data>` with XML content: drawing data, where yEd keeps its labels.
    Foreign(Owner),
    /// yEd's `<y:NodeLabel>` or `<y:EdgeLabel>`: its text is the element's label.
    YLabel {
        owner: Owner,
        text: String,
    },
    /// An element kgdiff does not read, and everything inside it.
    Skipped,
}

#[derive(Default)]
struct Reader {
    stack: Vec<Frame>,
    keys: IndexMap<String, Key>,
    graphs: usize,
    graph_data: Vec<Data>,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    /// `<hyperedge>` and `<port>` elements.
    unsupported: usize,
    /// `<data>` elements with XML content.
    structured: usize,
}

fn attribute<'a>(element: &'a XmlElement, name: &str) -> Option<&'a str> {
    element
        .attributes
        .iter()
        .find(|a| a.uri.is_empty() && a.local == name)
        .map(|a| a.value.as_str())
}

/// The element's GraphML name: its local name when it is in the GraphML namespace or in none
/// (some writers leave the namespace out).
fn graphml_name(element: &XmlElement) -> Option<&str> {
    (element.uri == GRAPHML_NS || element.uri.is_empty()).then_some(element.local.as_str())
}

impl Reader {
    fn required<'a>(element: &'a XmlElement, name: &str, what: &str) -> Result<&'a str, XmlError> {
        match attribute(element, name) {
            Some(value) => Ok(value),
            None => syntax(
                format!("<{what}> has no `{name}` attribute"),
                element.offset,
            ),
        }
    }

    fn graph(&mut self, element: &XmlElement) -> Frame {
        self.graphs += 1;
        Frame::Graph {
            first: self.graphs == 1,
            undirected: attribute(element, "edgedefault") == Some("undirected"),
        }
    }

    /// An element inside drawing data: yEd's label, or something to pass over.
    fn foreign(element: &XmlElement, owner: Owner) -> Frame {
        let yed = element.prefix == "y" || element.uri.contains("yworks");
        if yed && matches!(element.local.as_str(), "NodeLabel" | "EdgeLabel") {
            Frame::YLabel {
                owner,
                text: String::new(),
            }
        } else {
            Frame::Foreign(owner)
        }
    }

    fn data(element: &XmlElement, owner: Owner) -> Result<Frame, XmlError> {
        Ok(Frame::Data {
            owner,
            key: Reader::required(element, "key", "data")?.to_owned(),
            text: String::new(),
            structured: false,
        })
    }

    fn key(&mut self, element: &XmlElement) -> Result<Frame, XmlError> {
        let id = Reader::required(element, "id", "key")?.to_owned();
        let domain = match attribute(element, "for") {
            None | Some("all") => Domain::All,
            Some("graph") => Domain::Graph,
            Some("node") => Domain::Node,
            Some("edge") => Domain::Edge,
            Some(_) => Domain::Other,
        };
        self.keys.insert(
            id.clone(),
            Key {
                name: attribute(element, "attr.name").unwrap_or(&id).to_owned(),
                r#type: Type::of(attribute(element, "attr.type")),
                domain,
                default: None,
            },
        );
        Ok(Frame::Key(id))
    }

    fn child(&mut self, element: &XmlElement) -> Result<Frame, XmlError> {
        let name = graphml_name(element);
        let Some(parent) = self.stack.last_mut() else {
            return if name == Some("graphml") {
                Ok(Frame::Root)
            } else {
                syntax(
                    format!(
                        "the root element is <{}>, not <graphml>",
                        if element.prefix.is_empty() {
                            element.local.clone()
                        } else {
                            format!("{}:{}", element.prefix, element.local)
                        }
                    ),
                    element.offset,
                )
            };
        };
        if let Frame::Data {
            structured, owner, ..
        } = parent
        {
            *structured = true;
            return Ok(Reader::foreign(element, *owner));
        }
        if let Frame::Foreign(owner) = parent {
            return Ok(Reader::foreign(element, *owner));
        }
        let undirected = matches!(
            parent,
            Frame::Graph {
                undirected: true,
                ..
            }
        );
        let (in_graph, in_node, in_edge) = match parent {
            Frame::Graph { .. } => (true, false, false),
            Frame::Node(_) => (false, true, false),
            Frame::Edge(_) => (false, false, true),
            _ => (false, false, false),
        };
        let owner = match parent {
            Frame::Graph { first: true, .. } => Owner::Graph,
            Frame::Node(index) => Owner::Node(*index),
            Frame::Edge(index) => Owner::Edge(*index),
            _ => Owner::Nobody,
        };
        let key = match parent {
            Frame::Key(id) => Some(id.clone()),
            _ => None,
        };
        let root = matches!(parent, Frame::Root);
        match name {
            Some("key") if root => self.key(element),
            Some("graph") if root || in_node || in_edge => Ok(self.graph(element)),
            Some("default") if key.is_some() => Ok(Frame::Default {
                key: key.unwrap_or_default(),
                text: String::new(),
            }),
            Some("node") if in_graph => {
                self.nodes.push(Node {
                    id: Reader::required(element, "id", "node")?.to_owned(),
                    data: Vec::new(),
                    label: None,
                });
                Ok(Frame::Node(self.nodes.len() - 1))
            }
            Some("edge") if in_graph => {
                self.edges.push(Edge {
                    id: attribute(element, "id").map(str::to_owned),
                    source: Reader::required(element, "source", "edge")?.to_owned(),
                    target: Reader::required(element, "target", "edge")?.to_owned(),
                    // The edge's own `directed` wins over the graph's `edgedefault`.
                    undirected: match attribute(element, "directed") {
                        Some("false") => true,
                        Some("true") => false,
                        _ => undirected,
                    },
                    data: Vec::new(),
                    label: None,
                });
                Ok(Frame::Edge(self.edges.len() - 1))
            }
            Some("data") if in_graph || in_node || in_edge => Reader::data(element, owner),
            Some("hyperedge") if in_graph => {
                self.unsupported += 1;
                Ok(Frame::Skipped)
            }
            Some("port") if in_node => {
                self.unsupported += 1;
                Ok(Frame::Skipped)
            }
            // <desc>, <locator>, <data> of the document, elements of other vocabularies.
            _ => Ok(Frame::Skipped),
        }
    }
}

impl XmlHandler for Reader {
    fn start_element(&mut self, element: XmlElement) -> Result<(), XmlError> {
        let frame = self.child(&element)?;
        self.stack.push(frame);
        Ok(())
    }

    fn end_element(&mut self, _offset: usize) -> Result<(), XmlError> {
        match self.stack.pop() {
            Some(Frame::Default { key, text }) => {
                if let Some(declared) = self.keys.get_mut(&key) {
                    declared.default = Some(text);
                }
            }
            Some(Frame::Data {
                structured: true, ..
            }) => self.structured += 1,
            Some(Frame::YLabel { owner, text }) => {
                let text = js::trim(&text);
                let label = match owner {
                    Owner::Node(index) => Some(&mut self.nodes[index].label),
                    Owner::Edge(index) => Some(&mut self.edges[index].label),
                    Owner::Graph | Owner::Nobody => None,
                };
                // The first label with text: yEd lists a node's main label first.
                if let Some(label) = label
                    && label.is_none()
                    && !text.is_empty()
                {
                    *label = Some(text.to_owned());
                }
            }
            Some(Frame::Data {
                owner, key, text, ..
            }) => {
                let data = Data { key, text };
                match owner {
                    Owner::Graph => self.graph_data.push(data),
                    Owner::Node(index) => self.nodes[index].data.push(data),
                    Owner::Edge(index) => self.edges[index].data.push(data),
                    Owner::Nobody => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn text(&mut self, value: &str, _offset: usize) -> Result<(), XmlError> {
        if let Some(
            Frame::Default { text, .. } | Frame::Data { text, .. } | Frame::YLabel { text, .. },
        ) = self.stack.last_mut()
        {
            text.push_str(value);
        }
        Ok(())
    }

    fn processing_instruction(&mut self, _target: &str, _data: &str) -> Result<(), XmlError> {
        Ok(())
    }

    fn comment(&mut self, _value: &str) -> Result<(), XmlError> {
        Ok(())
    }
}

/// The value of `text` as a key's type says, and whether it is of that type.
pub(crate) fn typed(text: &str, r#type: Type) -> (Value, bool) {
    let value = match r#type {
        Type::Text => return (Value::from(text), true),
        Type::Integer => typed_value(text, Some("integer")),
        Type::Decimal => typed_value(text, Some("double")),
        // NetworkX writes Python's `True` and `False`.
        Type::Boolean => match js::trim(text).to_ascii_lowercase().as_str() {
            "true" | "1" => Value::Bool(true),
            "false" | "0" => Value::Bool(false),
            _ => Value::from(text),
        },
    };
    let fits = !matches!(value, Value::String(_));
    (value, fits)
}

/// How many fields the defaults of a document may add: as many as the input has bytes, and a
/// million for a small one. A default costs the file one declaration and the graph a field on
/// every element, so that without a limit a few hundred kilobytes ask for gigabytes.
pub(crate) struct DefaultBudget {
    limit: usize,
    used: usize,
    format: &'static str,
}

const MIN_DEFAULT_BUDGET: usize = 1_000_000;

impl DefaultBudget {
    pub(crate) fn new(input: &str, format: &'static str) -> DefaultBudget {
        DefaultBudget {
            limit: MIN_DEFAULT_BUDGET.max(input.len()),
            used: 0,
            format,
        }
    }

    /// Accounts for one field a default adds.
    pub(crate) fn take(&mut self) -> Result<(), KgdiffError> {
        self.used += 1;
        if self.used <= self.limit {
            return Ok(());
        }
        let name = if self.format == "gexf" {
            "GEXF"
        } else {
            "GraphML"
        };
        let mut details = Object::new();
        details.insert("format", self.format);
        Err(invalid_input_with(
            format!(
                "Invalid {name}: the <default> values add more than {} fields to the nodes and edges, the limit for an input of this size.",
                self.limit
            ),
            details,
        ))
    }
}

/// The ends of an undirected edge in code unit order, so that `a - b` and `b - a` are one edge.
pub(crate) fn undirected_ends<'a>(source: &'a str, target: &'a str) -> (&'a str, &'a str) {
    if compare_strings(source, target) == std::cmp::Ordering::Greater {
        (target, source)
    } else {
        (source, target)
    }
}

/// Turns what was read into node-link data.
struct Builder<'a> {
    keys: &'a IndexMap<String, Key>,
    /// Values that are not of their key's type.
    mistyped: usize,
    budget: DefaultBudget,
}

impl Builder<'_> {
    /// The fields of an element: its data, then the defaults of the keys it has no data for,
    /// then `label`, yEd's, when no field is the label. `reserved` fields come from the
    /// element's own attributes and are not overwritten.
    fn fields(
        &mut self,
        data: &[Data],
        domain: Domain,
        label: Option<&str>,
        reserved: Object,
    ) -> Result<Object, KgdiffError> {
        let mut fields = Object::new();
        let mut given: IndexSet<&str> = IndexSet::default();
        for item in data {
            given.insert(&item.key);
            let (name, r#type) = match self.keys.get(&item.key) {
                Some(key) => (key.name.as_str(), key.r#type),
                None => (item.key.as_str(), Type::Text),
            };
            let (value, fits) = typed(&item.text, r#type);
            if !fits {
                self.mistyped += 1;
            }
            fields.insert(name, value);
        }
        for (id, key) in self.keys {
            let Some(default) = &key.default else {
                continue;
            };
            if (key.domain == domain || key.domain == Domain::All) && !given.contains(id.as_str()) {
                self.budget.take()?;
                let (value, fits) = typed(default, key.r#type);
                if !fits {
                    self.mistyped += 1;
                }
                fields.insert(key.name.as_str(), value);
            }
        }
        if let Some(label) = label
            && !fields.contains_key("label")
        {
            fields.insert("label", label);
        }
        for (name, value) in reserved.iter() {
            fields.insert(name.clone(), value.clone());
        }
        Ok(fields)
    }
}

/// The edges whose id another edge has too.
fn shared_ids(edges: &[Edge]) -> usize {
    let mut counts: IndexMap<&str, usize> = IndexMap::default();
    for id in edges.iter().filter_map(|e| e.id.as_deref()) {
        *counts.entry(id).or_insert(0) += 1;
    }
    counts.values().filter(|&&n| n > 1).sum()
}

/// Reads a GraphML document into node-link data: `{ graph, nodes, links }`.
pub fn read_graphml(text: &str, warnings: &mut Warnings) -> Result<Value, KgdiffError> {
    let source = strip_bom(text);
    let mut reader = Reader::default();
    if !is_xml_space(source) {
        match parse_xml(source, &mut reader) {
            Ok(()) => {}
            Err((XmlError::Other(error), _)) => return Err(*error),
            Err((XmlError::Syntax { message, offset }, normalized)) => {
                let line = line_of(&normalized, offset);
                let mut details = Object::new();
                details.insert("format", "graphml");
                details.insert("line", line);
                return Err(invalid_input_with(
                    format!("Invalid GraphML: {message} on line {line}."),
                    details,
                ));
            }
        }
    }
    let mut builder = Builder {
        keys: &reader.keys,
        mistyped: 0,
        budget: DefaultBudget::new(source, "graphml"),
    };
    let mut nodes: Vec<Value> = Vec::with_capacity(reader.nodes.len());
    for node in &reader.nodes {
        let mut own = Object::new();
        own.insert("id", node.id.as_str());
        nodes.push(Value::Object(builder.fields(
            &node.data,
            Domain::Node,
            node.label.as_deref(),
            own,
        )?));
    }
    // Ids that edges share are not ids: NetworkX writes a multigraph's keys there.
    let shared = shared_ids(&reader.edges);
    let mut links: Vec<Value> = Vec::with_capacity(reader.edges.len());
    for edge in &reader.edges {
        let (source, target) = if edge.undirected {
            undirected_ends(&edge.source, &edge.target)
        } else {
            (edge.source.as_str(), edge.target.as_str())
        };
        let mut own = Object::new();
        own.insert("source", source);
        own.insert("target", target);
        if let Some(id) = edge.id.as_deref().filter(|_| shared == 0) {
            own.insert("id", id);
        }
        links.push(Value::Object(builder.fields(
            &edge.data,
            Domain::Edge,
            edge.label.as_deref(),
            own,
        )?));
    }
    let graph = builder.fields(&reader.graph_data, Domain::Graph, None, Object::new())?;

    if reader.graphs > 1 {
        warnings.count(
            ParseWarningCode::GraphMlMergedGraphs,
            |n| {
                format!(
                    "{} (nested, or after the first) merged into one graph.",
                    plural(n, "<graph> element")
                )
            },
            reader.graphs - 1,
        );
    }
    if reader.unsupported > 0 {
        warnings.count(
            ParseWarningCode::GraphMlUnsupportedElements,
            |n| format!("{} skipped.", plural(n, "<hyperedge> or <port> element")),
            reader.unsupported,
        );
    }
    if reader.structured > 0 {
        warnings.count(
            ParseWarningCode::GraphMlIgnoredData,
            |n| {
                format!(
                    "{} with XML content dropped (the drawing data of yEd and other editors; yEd's labels are kept).",
                    plural(n, "<data> element")
                )
            },
            reader.structured,
        );
    }
    if builder.mistyped > 0 {
        warnings.count(
            ParseWarningCode::GraphMlInvalidValue,
            |n| {
                format!(
                    "{} not of the type its <key> declares: kept as text.",
                    plural(n, "value")
                )
            },
            builder.mistyped,
        );
    }
    if shared > 0 {
        warnings.count(
            ParseWarningCode::GraphMlSharedEdgeIds,
            |n| {
                format!(
                    "{} with an id another edge has too: the edge ids are not read.",
                    plural(n, "edge")
                )
            },
            shared,
        );
    }

    let mut root = Object::new();
    root.insert("graph", Value::Object(graph));
    root.insert("nodes", Value::Array(nodes));
    root.insert("links", Value::Array(links));
    Ok(Value::Object(root))
}
