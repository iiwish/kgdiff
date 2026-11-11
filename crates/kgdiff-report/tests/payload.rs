//! The report payload and its layout (RFC 0003, part 2): the default layout, the caller's or
//! none; a given layout is checked against the diff; and every payload the crate writes
//! validates against `packages/core/schema/report.v1.json`.

#[path = "support/schema.rs"]
mod schema;

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{DiffResult, ErrorCode, Locale};
use kgdiff_layout::{
    LayoutOptions, LayoutResult, LayoutScope, layout_diff, layout_from_json, layout_to_json,
};
use kgdiff_report::{
    ReportInfo, ReportLayout, ReportSide, ViewerBundles, build_report_html, build_report_html_with,
    needs_compute, report_payload, report_payload_with,
};
use schema::Schemas;

const REPORT: &str = "report.v1.json";

/// The diff of two versions of a chain `<prefix>0 → <prefix>1 → …` of `before` and `after`
/// nodes, whose first node is renamed.
fn chain(prefix: &str, before: usize, after: usize) -> DiffResult {
    let graph = |n: usize, first: &str| {
        let nodes: Vec<String> = (0..n)
            .map(|i| {
                let label = if i == 0 { first } else { "Node" };
                format!(r#"{{"id":"{prefix}{i}","label":"{label} {i}"}}"#)
            })
            .collect();
        let edges: Vec<String> = (1..n)
            .map(|i| {
                format!(
                    r#"{{"source":"{prefix}{}","target":"{prefix}{i}","type":"next"}}"#,
                    i - 1
                )
            })
            .collect();
        json::parse(&format!(
            r#"{{"meta":{{"name":"chain"}},"nodes":[{}],"edges":[{}]}}"#,
            nodes.join(","),
            edges.join(",")
        ))
        .unwrap()
    };
    let options = kgdiff_core::resolve_options(None).unwrap();
    kgdiff_core::diff(&graph(before, "First"), &graph(after, "Renamed"), &options).unwrap()
}

fn info() -> ReportInfo {
    let side = |name: &str| ReportSide {
        name: name.to_owned(),
        format: Some("json".to_owned()),
    };
    ReportInfo {
        title: "chain 1 → chain 2".to_owned(),
        generator: "kgdiff 9.9.9".to_owned(),
        generated_at: Some("2026-11-10T00:00:00.000Z".to_owned()),
        before: side("chain 1"),
        after: side("chain 2"),
        mode: Some("swipe".to_owned()),
        scope: Some("all".to_owned()),
        theme: Some("light".to_owned()),
        locale: Locale::En,
        panels: Some(vec![
            ("detail".to_owned(), "collapsed".to_owned()),
            ("minimap".to_owned(), "hidden".to_owned()),
        ]),
        shapes: None,
    }
}

const STUBS: ViewerBundles<'static> = ViewerBundles {
    main: "/* viewer */",
    compute: Some("/* compute */"),
};

/// A layout of the changes only: the renamed node and its neighbour, of the chain's nodes.
fn changes_only(diff: &DiffResult) -> LayoutResult {
    let options = LayoutOptions {
        scope: Some(LayoutScope::Changes),
        ..LayoutOptions::default()
    };
    layout_diff(diff, &options).unwrap()
}

fn member<'a>(payload: &'a Value, name: &str) -> Option<&'a Value> {
    payload.as_object().unwrap().get(name)
}

fn assert_valid(schemas: &Schemas, payload: &Value) {
    assert_eq!(schemas.errors(REPORT, payload), Vec::<String>::new());
}

#[test]
fn the_default_layout_is_report_payload_byte_for_byte() {
    let diff = chain("n", 6, 7);
    let payload = report_payload_with(&diff, ReportLayout::Default, &info()).unwrap();
    assert_eq!(
        json::to_string(&payload),
        json::to_string(&report_payload(&diff, &info()))
    );
    let layout = layout_diff(&diff, &LayoutOptions::default()).unwrap();
    assert_eq!(member(&payload, "layout"), Some(&layout_to_json(&layout)));
    assert_eq!(
        build_report_html_with(&diff, ReportLayout::Default, &info(), STUBS).unwrap(),
        build_report_html(&diff, &info(), STUBS)
    );
}

#[test]
fn a_given_layout_appears_unchanged() {
    let diff = chain("n", 6, 7);
    let default = report_payload(&diff, &info());
    // Other options than the report's own, and a pinned node on the document's 0.01 grid.
    let mut options = LayoutOptions {
        seed: Some(7.0),
        link_distance: Some(120.0),
        ..LayoutOptions::default()
    };
    options.pinned.insert(
        "n3".into(),
        kgdiff_core::Point {
            x: 300.25,
            y: -40.5,
        },
    );
    let layout = layout_diff(&diff, &options).unwrap();
    let document = layout_to_json(&layout);
    let payload = report_payload_with(&diff, ReportLayout::Given(&layout), &info()).unwrap();
    assert_eq!(member(&payload, "layout"), Some(&document));
    assert_ne!(member(&default, "layout"), Some(&document));
    assert_eq!(
        json::to_string(
            &document
                .get("positions")
                .unwrap()
                .get("n3")
                .unwrap()
                .clone()
        ),
        "[300.25,-40.5]"
    );
    // Nothing else differs from the default payload, and the members keep their order.
    let without_layout = |payload: &Value| {
        let mut out = payload.as_object().unwrap().clone();
        out.remove("layout");
        json::to_string(&Value::Object(out))
    };
    assert_eq!(without_layout(&payload), without_layout(&default));
    let names: Vec<&str> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(
        names,
        ["format", "version", "diff", "layout", "meta", "view"]
    );
    // A full layout needs nothing computed in the browser.
    assert!(!needs_compute(&payload));
    let html = build_report_html_with(&diff, ReportLayout::Given(&layout), &info(), STUBS).unwrap();
    assert!(html.contains("/* viewer */") && !html.contains("/* compute */"));
    assert!(html.contains(&json::to_string(&document)));
}

#[test]
fn a_given_layout_of_the_changes_inlines_the_compute_add_on() {
    let diff = chain("n", 12, 12);
    let layout = changes_only(&diff);
    assert!(layout.positions.len() < diff.nodes.len());
    let payload = report_payload_with(&diff, ReportLayout::Given(&layout), &info()).unwrap();
    assert_eq!(member(&payload, "layout"), Some(&layout_to_json(&layout)));
    assert!(needs_compute(&payload));
    let html = build_report_html_with(&diff, ReportLayout::Given(&layout), &info(), STUBS).unwrap();
    assert!(html.find("/* viewer */").unwrap() < html.find("/* compute */").unwrap());
}

#[test]
fn a_version_1_layout_read_back_stays_version_1() {
    let diff = chain("n", 6, 7);
    let mut document = layout_to_json(&layout_diff(&diff, &LayoutOptions::default()).unwrap());
    if let Value::Object(o) = &mut document {
        o.remove("generator");
        o.insert("version", 1);
    }
    let layout = layout_from_json(&document).unwrap();
    let payload = report_payload_with(&diff, ReportLayout::Given(&layout), &info()).unwrap();
    assert_eq!(member(&payload, "layout"), Some(&document));
    assert_valid(&Schemas::load(), &payload);
}

#[test]
fn no_layout_leaves_the_member_out() {
    let diff = chain("n", 6, 7);
    let payload = report_payload_with(&diff, ReportLayout::None, &info()).unwrap();
    assert_eq!(member(&payload, "layout"), None);
    assert!(needs_compute(&payload));
    let mut expected = report_payload(&diff, &info());
    if let Value::Object(o) = &mut expected {
        o.remove("layout");
    }
    assert_eq!(json::to_string(&payload), json::to_string(&expected));
    let html = build_report_html_with(&diff, ReportLayout::None, &info(), STUBS).unwrap();
    assert!(html.find("/* viewer */").unwrap() < html.find("/* compute */").unwrap());
    assert!(!html.contains("kgdiff.layout"));
}

#[test]
fn a_layout_of_another_diff_is_rejected() {
    let diff = chain("n", 6, 7);
    let rejected = |layout: &LayoutResult, node: &str, message: &str| {
        let error = report_payload_with(&diff, ReportLayout::Given(layout), &info()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, message);
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("node")),
            Some(&Value::from(node))
        );
        assert_eq!(
            build_report_html_with(&diff, ReportLayout::Given(layout), &info(), STUBS).unwrap_err(),
            error
        );
    };
    let default = LayoutOptions::default();

    // Other ids altogether.
    let other = layout_diff(&chain("m", 6, 7), &default).unwrap();
    rejected(
        &other,
        "m0",
        "The report's layout has a position for \"m0\", which is not a node of the diff.",
    );
    // A later diff of the same graph: one node more than this diff has.
    let larger = layout_diff(&chain("n", 7, 8), &default).unwrap();
    rejected(
        &larger,
        "n7",
        "The report's layout has a position for \"n7\", which is not a node of the diff.",
    );
    // An earlier one: every position is a node of this diff, but scope `all` promises them all.
    let smaller = layout_diff(&chain("n", 5, 6), &default).unwrap();
    assert_eq!(smaller.scope, LayoutScope::All);
    rejected(
        &smaller,
        "n6",
        "The report's layout has scope \"all\" but no position for node \"n6\" of the diff.",
    );
    // This diff's own layout with a node taken out.
    let mut holed = layout_diff(&diff, &default).unwrap();
    holed.positions.shift_remove("n2");
    rejected(
        &holed,
        "n2",
        "The report's layout has scope \"all\" but no position for node \"n2\" of the diff.",
    );

    // Scope `changes` promises no more than the nodes it has, but they must be this diff's.
    let diff = chain("n", 12, 12);
    assert!(report_payload_with(&diff, ReportLayout::Given(&changes_only(&diff)), &info()).is_ok());
    let error = report_payload_with(
        &diff,
        ReportLayout::Given(&changes_only(&chain("m", 12, 12))),
        &info(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn shapes_go_into_the_view_in_their_order_and_only_when_given() {
    let diff = chain("n", 6, 7);
    let plain = report_payload(&diff, &info());
    assert_eq!(member(&plain, "view").unwrap().get("shapes"), None);

    let with_shapes = ReportInfo {
        shapes: Some(vec![
            ("Rule".to_owned(), "diamond".to_owned()),
            ("Concept".to_owned(), "hexagon".to_owned()),
            ("Metric".to_owned(), "square".to_owned()),
        ]),
        ..info()
    };
    let payload = report_payload(&diff, &with_shapes);
    let shapes = member(&payload, "view").unwrap().get("shapes").unwrap();
    assert_eq!(
        json::to_string(shapes),
        r#"{"Rule":"diamond","Concept":"hexagon","Metric":"square"}"#
    );
    assert!(Schemas::load().errors(REPORT, &payload).is_empty());

    // Only `view` changes: everything else is byte for byte the payload without shapes.
    let mut without = payload.as_object().unwrap().clone();
    let mut view = member(&payload, "view")
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    view.remove("shapes");
    without.insert("view", Value::Object(view));
    assert_eq!(
        json::to_string(&Value::Object(without)),
        json::to_string(&plain)
    );
}

#[test]
fn every_payload_validates_against_the_schema() {
    let schemas = Schemas::load();
    let bare = ReportInfo {
        generated_at: None,
        mode: None,
        scope: None,
        theme: None,
        panels: None,
        before: ReportSide {
            name: "a".to_owned(),
            format: None,
        },
        ..info()
    };
    for diff in [
        chain("n", 6, 7),
        chain("n", 12, 12),
        chain("n", 0, 3),
        chain("n", 0, 0),
    ] {
        let given = layout_diff(
            &diff,
            &LayoutOptions {
                seed: Some(7.0),
                ..LayoutOptions::default()
            },
        )
        .unwrap();
        let changes = changes_only(&diff);
        for info in [info(), bare.clone()] {
            assert_valid(&schemas, &report_payload(&diff, &info));
            for layout in [
                ReportLayout::Default,
                ReportLayout::Given(&given),
                ReportLayout::Given(&changes),
                ReportLayout::None,
            ] {
                assert_valid(
                    &schemas,
                    &report_payload_with(&diff, layout, &info).unwrap(),
                );
            }
        }
    }
}

#[test]
fn the_schema_describes_the_payload_and_nothing_else() {
    let schemas = Schemas::load();
    let diff = chain("n", 6, 7);
    let payload = report_payload(&diff, &info());
    let with = |path: &[&str], value: Option<Value>| {
        fn set(target: &mut Value, path: &[&str], value: Option<Value>) {
            let Value::Object(object) = target else {
                panic!("not an object at {path:?}");
            };
            match (path, value) {
                ([name], Some(value)) => {
                    object.insert(*name, value);
                }
                ([name], None) => {
                    object.remove(name);
                }
                ([name, rest @ ..], value) => set(object.get_mut(name).unwrap(), rest, value),
                ([], _) => unreachable!(),
            }
        }
        let mut out = payload.clone();
        set(&mut out, path, value);
        out
    };
    let object =
        |members: &[(&str, Value)]| Value::Object(members.iter().cloned().collect::<Object>());

    // What readers accept: a diff that is not packed, no view, no title, and members of `view`
    // this version does not know (later versions add optional ones; RFC 0003, Compatibility).
    for (path, value) in [
        (&["diff"][..], Some(kgdiff_core::diff_to_json(&diff))),
        (&["view"], None),
        (&["view"], Some(object(&[]))),
        (&["meta", "title"], None),
        (&["view", "palette"], Some("colorblind".into())),
        (&["view", "mode"], Some("changes".into())),
        (
            &["view", "shapes"],
            Some(object(&[("Class", "square".into())])),
        ),
        (&["view", "plain"], Some(true.into())),
    ] {
        assert_valid(&schemas, &with(path, value));
    }

    // What the writer never writes.
    let delta = kgdiff_core::diff_to_json(&diff)
        .get("delta")
        .unwrap()
        .clone();
    let layout = member(&payload, "layout").unwrap().clone();
    let layout_with = |name: &str, value: Value| {
        let mut out = layout.as_object().unwrap().clone();
        out.insert(name, value);
        Value::Object(out)
    };
    for (case, path, value) in [
        (
            "another format",
            &["format"][..],
            Some("kgdiff.diff".into()),
        ),
        ("a newer version", &["version"], Some(2.into())),
        ("no version", &["version"], None),
        ("no diff", &["diff"], None),
        ("a diff that is none", &["diff"], Some(object(&[]))),
        ("a delta for a diff", &["diff"], Some(delta.clone())),
        ("a null layout", &["layout"], Some(Value::Null)),
        (
            "a layout of version 3",
            &["layout"],
            Some(layout_with("version", 3.into())),
        ),
        (
            "a version 1 layout with a generator",
            &["layout"],
            Some(layout_with("version", 1.into())),
        ),
        (
            "a layout with a position that is no point",
            &["layout", "positions", "n0"],
            Some(1.into()),
        ),
        ("no meta", &["meta"], None),
        ("no generator", &["meta", "generator"], None),
        ("a side without a name", &["meta", "before", "name"], None),
        (
            "a misspelt member of meta",
            &["meta", "generatedat"],
            Some("x".into()),
        ),
        ("a member at the top level", &["title"], Some("x".into())),
        ("a view that is no object", &["view"], Some("swipe".into())),
        (
            "an unknown mode",
            &["view", "mode"],
            Some("sideways".into()),
        ),
        (
            "an unknown scope",
            &["view", "scope"],
            Some("context".into()),
        ),
        ("an unknown theme", &["view", "theme"], Some("sepia".into())),
        ("an unknown locale", &["view", "locale"], Some("fr".into())),
        (
            "an unknown region",
            &["view", "panels", "sidebar"],
            Some("open".into()),
        ),
        (
            "an unknown panel state",
            &["view", "panels", "list"],
            Some("closed".into()),
        ),
        (
            "an unknown shape",
            &["view", "shapes"],
            Some(object(&[("Class", "triangle".into())])),
        ),
    ] {
        assert!(
            !schemas.errors(REPORT, &with(path, value)).is_empty(),
            "the schema accepts {case}"
        );
    }
}
