//! The layout document (`packages/layout/test/json.test.ts`): version 2 with `generator`,
//! validated against `packages/core/schema/layout.v2.json`; versions 1 and 2 read back.

#[path = "support/schema.rs"]
mod schema;
mod support;

use kgdiff_core::js::{Object, Value, json};
use kgdiff_layout::{
    GENERATOR, LayoutOptions, LayoutScope, layout_diff, layout_from_json, layout_to_json,
};
use schema::Schemas;
use support::{GraphSpec, NodeSpec, changes, components};

fn scoped() -> (Value, kgdiff_layout::LayoutResult) {
    let mut options = LayoutOptions::default();
    options.scope = Some(LayoutScope::Changes);
    let layout = layout_diff(&changes(17).diff(), &options).unwrap();
    (layout_to_json(&layout), layout)
}

fn is_hundredth(v: f64) -> bool {
    kgdiff_core::js::math::round(v * 100.0) / 100.0 == v
}

#[test]
fn writes_version_2_with_the_generator_and_no_timing() {
    let (document, layout) = scoped();
    let text = json::to_string(&document);
    assert!(text.starts_with(r#"{"format":"kgdiff.layout","version":2,"generator":"kgdiff-layout/1","strategy":"union","scope":"changes","iterations":"#), "{text}");
    assert!(!text.contains("\"ms\""));
    let count = |name: &str| document.get(name).unwrap().as_object().unwrap().len();
    assert_eq!(count("positions"), layout.positions.len());
    assert_eq!(count("hidden"), layout.hidden.len());
    assert_eq!(layout.generator.as_deref(), Some(GENERATOR));
}

#[test]
fn validates_against_the_schema() {
    let schemas = Schemas::load();
    let errors = |value: &Value| schemas.errors("layout.v2.json", value);
    let (document, _) = scoped();
    assert_eq!(errors(&document), Vec::<String>::new());
    let all = layout_to_json(
        &layout_diff(&components(30, 40, 3).diff(), &LayoutOptions::default()).unwrap(),
    );
    assert_eq!(errors(&all), Vec::<String>::new());
    let empty = layout_to_json(
        &layout_diff(&GraphSpec::default().diff(), &LayoutOptions::default()).unwrap(),
    );
    assert_eq!(errors(&empty), Vec::<String>::new());

    // The schema rejects what the writer never writes.
    let with = |name: &str, value: Value| {
        let mut out = document.as_object().unwrap().clone();
        out.insert(name, value);
        Value::Object(out)
    };
    for (name, value) in [
        ("version", Value::from(1u32)),
        ("generator", Value::from("")),
        ("strategy", Value::from("random")),
        ("iterations", Value::from(1.5)),
        ("extra", Value::from(true)),
        ("hidden", json::parse(r#"{"a":0}"#).unwrap()),
        ("positions", json::parse(r#"{"a":[1]}"#).unwrap()),
        ("positions", json::parse(r#"{"a":[1,2,3]}"#).unwrap()),
        ("bounds", json::parse(r#"{"x":0}"#).unwrap()),
    ] {
        assert!(
            !errors(&with(name, value.clone())).is_empty(),
            "{name}: {}",
            json::to_string(&value)
        );
    }
}

#[test]
fn rounds_coordinates_and_radii_to_hundredths() {
    let (document, _) = scoped();
    for p in document
        .get("positions")
        .unwrap()
        .as_object()
        .unwrap()
        .values()
    {
        for c in p.as_array().unwrap() {
            assert!(is_hundredth(c.as_f64().unwrap()));
        }
    }
    for r in document.get("radii").unwrap().as_object().unwrap().values() {
        assert!(is_hundredth(r.as_f64().unwrap()));
    }
}

#[test]
fn round_trips_through_text() {
    let (document, layout) = scoped();
    let text = json::to_string(&document);
    let back = layout_from_json(&json::parse(&text).unwrap()).unwrap();
    assert_eq!(json::to_string(&layout_to_json(&back)), text);
    assert_eq!(back.stats.nodes, layout.positions.len());
    assert_eq!(back.generator.as_deref(), Some(GENERATOR));
    for (id, p) in &layout.positions {
        let q = back.positions[id.as_str()];
        assert!((q.x - p.x).abs() < 0.005 && (q.y - p.y).abs() < 0.005);
    }
    let nodes = |l: &kgdiff_layout::LayoutResult| -> Vec<Vec<String>> {
        l.components
            .iter()
            .map(|c| c.nodes.iter().map(ToString::to_string).collect())
            .collect()
    };
    assert_eq!(nodes(&back), nodes(&layout));
    // Any seed: the round trip is idempotent.
    let diff = components(6, 4, 3).diff();
    for seed in [0.0, 1.0, 17.0, 2_147_483_648.0, 0.25] {
        let mut options = LayoutOptions::default();
        options.seed = Some(seed);
        options.iterations = Some(30);
        let once = layout_to_json(&layout_diff(&diff, &options).unwrap());
        let twice = layout_to_json(&layout_from_json(&once).unwrap());
        assert_eq!(json::to_string(&once), json::to_string(&twice));
    }
}

#[test]
fn reads_version_1_and_writes_it_back_as_version_1() {
    let (document, _) = scoped();
    let mut v1 = document.as_object().unwrap().clone();
    v1.insert("version", 1u32);
    v1.remove("generator");
    let v1 = Value::Object(v1);
    let back = layout_from_json(&v1).unwrap();
    assert_eq!(back.generator, None);
    assert_eq!(
        json::to_string(&layout_to_json(&back)),
        json::to_string(&v1)
    );
}

#[test]
fn does_not_depend_on_map_insertion_order() {
    let (document, layout) = scoped();
    let mut reversed = layout.clone();
    reversed.positions.reverse();
    reversed.radii.reverse();
    reversed.hidden.reverse();
    assert_eq!(
        json::to_string(&layout_to_json(&reversed)),
        json::to_string(&document)
    );
}

#[test]
fn keeps_awkward_ids_as_plain_data() {
    let ids = [
        "__proto__",
        "constructor",
        "0",
        "10",
        "2",
        "a\"b",
        "x|y",
        "http://e.org/a#b",
        "中文",
    ];
    let spec = GraphSpec {
        nodes: ids.iter().map(|id| NodeSpec::new(id, id)).collect(),
        edges: vec![],
    };
    let document = layout_to_json(&layout_diff(&spec.diff(), &LayoutOptions::default()).unwrap());
    let keys: Vec<String> = document
        .get("positions")
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .map(ToString::to_string)
        .collect();
    // JavaScript's object order: array indices numerically, then the rest as inserted (sorted).
    assert_eq!(
        keys,
        [
            "0",
            "2",
            "10",
            "__proto__",
            "a\"b",
            "constructor",
            "http://e.org/a#b",
            "x|y",
            "中文"
        ]
    );
    let back = layout_from_json(&json::parse(&json::to_string(&document)).unwrap()).unwrap();
    let mut sorted: Vec<&str> = ids.to_vec();
    sorted.sort_by(|a, b| kgdiff_core::js::cmp_utf16(a, b));
    let read: Vec<&str> = back.positions.keys().map(|k| k.as_str()).collect();
    assert_eq!(read, sorted);
}

#[test]
fn rejects_other_documents_and_versions() {
    let (document, _) = scoped();
    let with = |name: &str, value: Value| {
        let mut out: Object = document.as_object().unwrap().clone();
        out.insert(name, value);
        Value::Object(out)
    };
    let code = |value: &Value| layout_from_json(value).unwrap_err().code.as_str();
    assert_eq!(code(&Value::Null), "invalid-input");
    assert_eq!(
        code(&with("format", Value::from("kgdiff.diff"))),
        "invalid-input"
    );
    assert_eq!(
        code(&with("version", Value::from(3u32))),
        "unsupported-version"
    );
    assert_eq!(
        layout_from_json(&with("version", Value::from(3u32)))
            .unwrap_err()
            .message,
        "Unsupported kgdiff.layout version 3"
    );
    assert_eq!(code(&with("generator", Value::Null)), "invalid-input");
    assert_eq!(
        code(&with("strategy", Value::from("random"))),
        "invalid-input"
    );
    for (name, text) in [
        ("positions", r#"{"a":[1]}"#),
        ("positions", r#"{"a":[1,"x"]}"#),
        ("radii", r#"{"a":null}"#),
        ("hidden", r#"{"a":1.5}"#),
        ("bounds", r#"{"x":0}"#),
        (
            "components",
            r#"[{"nodes":[1],"bounds":{"x":0,"y":0,"width":0,"height":0}}]"#,
        ),
    ] {
        assert_eq!(
            code(&with(name, json::parse(text).unwrap())),
            "invalid-input",
            "{name}"
        );
    }
    assert_eq!(
        layout_from_json(&with("positions", json::parse(r#"{"a":[1]}"#).unwrap()))
            .unwrap_err()
            .message,
        "layoutFromJSON: positions[\"a\"] must be [x, y]"
    );
}
