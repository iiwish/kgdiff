//! The workloads of `packages/core/test/support/synthetic.ts`, with the same mulberry32 stream,
//! for the benchmarks and the memory example. Graphs come back as kgdiff reads them: written as
//! JSON text and parsed, so that repeated text is shared as [`json::parse`] shares it.

use kgdiff_core::js::{Object, Value, json};

/// A graph as kgdiff reads it from a file.
fn as_read(graph: Value) -> Value {
    json::parse(&json::to_string(&graph)).expect("JSON")
}

/// mulberry32, as `prng` of `test/support/synthetic.ts`.
struct Prng(u32);

impl Prng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `Math.floor(random() * n)`.
    fn below(&mut self, n: usize) -> usize {
        let n = u32::try_from(n).expect("small sizes");
        let x = (self.next() * f64::from(n)).floor();
        usize::try_from(kgdiff_core::js::to_uint32(x)).expect("fits")
    }
}

const PREDICATES: [&str; 6] = ["knows", "worksFor", "is_a", "partOf", "locatedIn", "owns"];
const TYPES: [&str; 4] = ["Person", "Organization", "Place", "Event"];

fn node(id: &str, label: &str, ty: Option<&str>, attrs: Option<Object>) -> Value {
    let mut out = Object::new();
    out.insert("id", id);
    out.insert("label", label);
    if let Some(ty) = ty {
        out.insert("type", ty);
    }
    if let Some(attrs) = attrs {
        out.insert("attrs", attrs);
    }
    Value::Object(out)
}

fn edge(source: &str, target: &str, predicate: &str) -> Value {
    let mut out = Object::new();
    out.insert("source", source);
    out.insert("target", target);
    out.insert("predicate", predicate);
    Value::Object(out)
}

fn graph(nodes: Vec<Value>, edges: Vec<Value>) -> Value {
    let mut out = Object::new();
    out.insert("nodes", Value::Array(nodes));
    out.insert("edges", Value::Array(edges));
    as_read(Value::Object(out))
}

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `syntheticGraph(n, e)`: exact ids `n0…`, typed, labelled and attributed.
pub fn synthetic_graph(n: usize, e: usize, seed: u32) -> Value {
    let mut random = Prng(seed);
    let nodes = (0..n)
        .map(|i| {
            let mut attrs = Object::new();
            attrs.insert("rank", i % 17);
            attrs.insert("code", format!("C-{i}"));
            node(
                &format!("n{i}"),
                &format!("Node {i}"),
                Some(TYPES[i % TYPES.len()]),
                Some(attrs),
            )
        })
        .collect();
    let edges = (0..e)
        .map(|_| {
            let (s, t) = (random.below(n), random.below(n));
            edge(
                &format!("n{s}"),
                &format!("n{t}"),
                PREDICATES[random.below(PREDICATES.len())],
            )
        })
        .collect();
    graph(nodes, edges)
}

/// `editGraph`: ~1% renames, attribute edits, removals, additions, retargets.
pub fn edit_graph(g: &Value, seed: u32) -> Value {
    let mut random = Prng(seed);
    let list = |k: &str| g.get(k).and_then(Value::as_array).unwrap_or(&[]).to_vec();
    let mut nodes: Vec<Value> = Vec::new();
    for n in list("nodes") {
        if random.next() <= 0.005 {
            continue;
        }
        if random.next() < 0.01 {
            let Value::Object(mut o) = n else { continue };
            let label = format!(
                "{} (renamed)",
                o.get("label").and_then(Value::as_str).unwrap_or("")
            );
            o.insert("label", label);
            if let Some(Value::Object(attrs)) = o.get_mut("attrs") {
                attrs.insert("rank", -1);
            }
            nodes.push(Value::Object(o));
        } else {
            nodes.push(n);
        }
    }
    let kept: std::collections::BTreeSet<String> =
        nodes.iter().map(|n| field(n, "id").to_owned()).collect();
    let extra: Vec<Value> = (0..list("nodes").len().div_ceil(200))
        .map(|i| node(&format!("new{i}"), &format!("New {i}"), None, None))
        .collect();
    let mut edges: Vec<Value> = Vec::new();
    for e in list("edges") {
        if !(kept.contains(field(&e, "source"))
            && kept.contains(field(&e, "target"))
            && random.next() > 0.01)
        {
            continue;
        }
        if random.next() < 0.005 {
            let target = field(&nodes[random.below(nodes.len())], "id").to_owned();
            edges.push(edge(field(&e, "source"), &target, field(&e, "predicate")));
        } else {
            edges.push(e);
        }
    }
    let first = field(&nodes[0], "id").to_owned();
    for n in &extra {
        edges.push(edge(field(n, "id"), &first, "knows"));
    }
    nodes.extend(extra);
    graph(nodes, edges)
}

/// `extractionPair(n)`: two extractions of the same entities with unrelated random ids.
#[allow(
    clippy::disallowed_methods,
    reason = "benchmark input, as `toUpperCase` in synthetic.ts"
)]
pub fn extraction_pair(n: usize, seed: u32) -> (Value, Value) {
    const FIRST: [&str; 13] = [
        "Marie", "Pierre", "Ada", "Alan", "Grace", "Emmy", "Niels", "Lise", "Rosalind", "Dmitri",
        "李", "王", "张",
    ];
    const LAST: [&str; 12] = [
        "Curie",
        "Lovelace",
        "Turing",
        "Hopper",
        "Noether",
        "Bohr",
        "Meitner",
        "Franklin",
        "Mendeleev",
        "明",
        "华",
        "强",
    ];
    const ORGS: [&str; 6] = [
        "University",
        "Institute",
        "Laboratory",
        "Society",
        "Academy",
        "College",
    ];
    const PLACES: [&str; 8] = [
        "Paris",
        "Warsaw",
        "London",
        "Copenhagen",
        "Vienna",
        "Berlin",
        "Beijing",
        "Shanghai",
    ];
    let mut random = Prng(seed);
    let entities: Vec<(String, &str)> = (0..n)
        .map(|i| match i % 3 {
            0 => (
                format!("{} {} {i}", FIRST[random.below(13)], LAST[random.below(12)]),
                "Person",
            ),
            1 => (
                format!(
                    "{} of {} {i}",
                    ORGS[random.below(6)],
                    PLACES[random.below(8)]
                ),
                "Organization",
            ),
            _ => (format!("{} Station {i}", PLACES[random.below(8)]), "Place"),
        })
        .collect();
    let links: Vec<(usize, usize)> = (0..n * 2)
        .map(|_| (random.below(n), random.below(n)))
        .collect();
    let mut build = |prefix: &str, rename: bool| {
        let ids: Vec<String> = entities
            .iter()
            .map(|_| format!("{prefix}_{:x}", random.below(1_000_000_000)))
            .collect();
        let nodes = entities
            .iter()
            .zip(&ids)
            .map(|((label, ty), id)| {
                let label = if !rename {
                    label.clone()
                } else {
                    let r = random.next();
                    if r < 0.15 {
                        label.replacen("University", "Univ.", 1)
                    } else if r < 0.25 {
                        label.to_uppercase()
                    } else if r < 0.3 {
                        format!("{label} (disambiguated)")
                    } else {
                        label.clone()
                    }
                };
                node(id, &label, Some(ty), None)
            })
            .collect();
        let edges = links
            .iter()
            .map(|&(s, t)| edge(&ids[s], &ids[t], "related"))
            .collect();
        graph(nodes, edges)
    };
    let a = build("a", false);
    let b = build("b", true);
    (a, b)
}
