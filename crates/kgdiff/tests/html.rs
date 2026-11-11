//! The report document, its payload with the
//! precomputed diff and layout, escaping, compression, and when the compute add-on is inlined.

mod common;

use common::{dataset, extract_payload, io, re, run_with};
use kgdiff::testing::{FAKE_BUNDLE, FAKE_COMPUTE, MemoryIo};
use kgdiff_core::js::{Value, json};
use kgdiff_core::unpack_diff_json;
use kgdiff_report::ViewerBundles;
use kgdiff_report::html::{
    encode_payload, escape_html, render_report_html, script_safe_js, script_safe_json,
};

const BEFORE: &str = r#"{"meta":{"name":"kg","version":"1"},"nodes":[{"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}],"edges":[{"source":"a","target":"b","predicate":"knows"}]}"#;
const AFTER: &str = r#"{"meta":{"name":"kg","version":"2"},"nodes":[{"id":"a","label":"Alpha</script><script>alert(1)</script>"},{"id":"b","label":"Beta"},{"id":"c","label":"<!-- Gamma -->"}],"edges":[{"source":"a","target":"b","predicate":"knows"},{"source":"c","target":"a","predicate":"knows"}]}"#;

fn files() -> MemoryIo {
    io().file("v1.json", BEFORE).file("v2.json", AFTER)
}

fn report_with(extra: &[&str], io: MemoryIo) -> String {
    let mut argv = vec!["v1.json", "v2.json", "-o", "report.html", "-q"];
    argv.extend(extra);
    let r = run_with(&argv, io);
    assert_eq!(r.code, 0, "{}", r.stderr);
    r.file("report.html")
}

fn report(extra: &[&str]) -> String {
    report_with(extra, files())
}

fn payload_of(html: &str) -> Value {
    extract_payload(html).1
}

/// The diff a report embeds, unpacked.
fn diff_of(payload: &Value) -> Value {
    unpack_diff_json(payload.get("diff").unwrap()).unwrap()
}

fn count(html: &str, pattern: &str) -> usize {
    re(pattern).find_iter(html).count()
}

#[test]
fn is_a_complete_accessible_single_file_document() {
    let html = report(&["--locale", "zh-CN"]);
    assert!(
        html.starts_with(
            "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">"
        )
    );
    assert!(
        html.contains("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
    );
    assert!(html.contains("<title>kg 1 → 2 · kgdiff</title>"));
    assert!(html.contains("<meta name=\"generator\" content=\"kgdiff "));
    assert!(
        re(r#"<meta name="description" content="2 组共 \d+ 处变化 · 节点 2 → 3 · 关系 1 → 2">"#)
            .is_match(&html)
    );
    assert!(html.contains("<main>\n<h1 class=\"kgdiff-sr\">kg 1 → 2</h1>"));
    // Theme and language travel in the payload's view (a reader's earlier choice wins).
    assert!(html.contains("<kgdiff-viewer id=\"kgdiff\" global-shortcuts></kgdiff-viewer>"));
    assert_eq!(
        json::to_string(payload_of(&html).get("view").unwrap()),
        r#"{"locale":"zh-CN"}"#
    );
    assert!(html.contains("<noscript>"));
    assert!(html.contains("<script type=\"application/kgdiff+json\" data-for=\"kgdiff\">"));
    assert!(html.contains(&format!("<script>{FAKE_BUNDLE}</script>")));
    assert!(html.find("application/kgdiff+json").unwrap() < html.find(FAKE_BUNDLE).unwrap());
    assert!(kgdiff_core::js::trim_end(&html).ends_with("</html>"));
}

#[test]
fn paints_the_theme_background_before_the_viewer_loads() {
    let auto = report(&[]);
    assert!(auto.contains("html,body{background:#0B0E14;color:#E7EBF3}"));
    assert!(auto.contains(
        "@media (prefers-color-scheme:light){html,body{background:#F7F8FA;color:#0F172A}}"
    ));
    let light = report(&["--theme", "light"]);
    assert!(light.contains(":root{color-scheme:light}html,body{background:#F7F8FA"));
    assert!(!light.contains("#0B0E14") && !light.contains("theme="));
    assert_eq!(
        payload_of(&light)
            .get("view")
            .and_then(|v| v.get("theme"))
            .and_then(Value::as_str),
        Some("light")
    );
    let dark = report(&["--theme", "dark", "--mode", "replay"]);
    assert!(!dark.contains("prefers-color-scheme"));
    assert!(dark.contains("mode=\"replay\"") && !dark.contains("scope="));
}

#[test]
fn sets_the_scope_and_reads_the_legacy_mode_changes() {
    let scoped = report(&["--mode", "swipe", "--scope", "changes"]);
    assert!(scoped.contains("mode=\"swipe\" scope=\"changes\""));
    let view = payload_of(&scoped).get("view").cloned().unwrap();
    assert_eq!(view.get("mode").and_then(Value::as_str), Some("swipe"));
    assert_eq!(view.get("scope").and_then(Value::as_str), Some("changes"));
    assert!(report(&["--mode", "changes"]).contains("mode=\"overlay\" scope=\"changes\""));
    // An explicit --scope wins over the one the legacy mode implies.
    assert!(
        report(&["--mode", "changes", "--scope", "all"]).contains("mode=\"overlay\" scope=\"all\"")
    );
}

#[test]
fn embeds_the_precomputed_diff_layout_meta_and_view_preferences() {
    let html = report(&["--mode", "swipe", "--title", "Release <2>"]);
    let (encoding, payload) = extract_payload(&html);
    assert!(encoding.is_none());
    assert_eq!(
        payload.get("format").and_then(Value::as_str),
        Some("kgdiff.report")
    );
    assert_eq!(payload.get("version").and_then(Value::as_f64), Some(1.0));
    assert_eq!(
        payload
            .get("diff")
            .and_then(|d| d.get("format"))
            .and_then(Value::as_str),
        Some("kgdiff.diff.packed")
    );
    let ids: Vec<String> = diff_of(&payload)
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|n| n.get("id").and_then(Value::as_str).unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["a", "b", "c"]);
    // The layout of kgdiff-layout, as a version 2 layout document.
    let layout = payload.get("layout").expect("a layout");
    assert_eq!(
        layout.get("format").and_then(Value::as_str),
        Some("kgdiff.layout")
    );
    assert_eq!(layout.get("version").and_then(Value::as_f64), Some(2.0));
    assert_eq!(
        layout.get("generator").and_then(Value::as_str),
        Some(kgdiff_layout::GENERATOR)
    );
    let placed: Vec<&str> = layout
        .get("positions")
        .and_then(Value::as_object)
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(placed, ["a", "b", "c"]);
    let meta = payload.get("meta").unwrap();
    assert_eq!(
        meta.get("title").and_then(Value::as_str),
        Some("Release <2>")
    );
    assert_eq!(
        meta.get("generatedAt").and_then(Value::as_str),
        Some("2026-11-01T12:00:00.000Z")
    );
    assert_eq!(
        json::to_string(meta.get("before").unwrap()),
        r#"{"name":"kg 1","format":"json"}"#
    );
    assert_eq!(
        json::to_string(meta.get("after").unwrap()),
        r#"{"name":"kg 2","format":"json"}"#
    );
    assert!(
        re(r"^kgdiff \d+\.\d+\.\d+$")
            .is_match(meta.get("generator").and_then(Value::as_str).unwrap())
    );
    assert_eq!(
        json::to_string(payload.get("view").unwrap()),
        r#"{"mode":"swipe","locale":"en"}"#
    );
    assert!(html.contains("<title>Release &lt;2&gt; · kgdiff</title>"));
}

#[test]
fn embeds_panels_in_the_view_not_as_an_attribute() {
    let html = report(&["--panels", "detail:collapsed", "--panels", "minimap:hidden"]);
    assert!(!html.contains("panels="));
    assert_eq!(
        json::to_string(payload_of(&html).get("view").unwrap()),
        r#"{"locale":"en","panels":{"detail":"collapsed","minimap":"hidden"}}"#
    );
}

#[test]
fn cannot_be_broken_out_of_by_labels() {
    let html = report(&[]);
    // The payload and the viewer: a full layout needs no compute add-on.
    assert_eq!(count(&html, r"(?i)<script\b"), 2);
    assert_eq!(count(&html, r"(?i)</script"), 2);
    assert!(!html.contains("<!--"));
    let labels: Vec<String> = diff_of(&payload_of(&html))
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|n| {
            n.get("after")
                .and_then(|a| a.get("label"))
                .or_else(|| n.get("id"))
                .and_then(Value::as_str)
                .unwrap()
                .to_owned()
        })
        .collect();
    assert!(
        labels
            .iter()
            .any(|l| l == "Alpha</script><script>alert(1)</script>")
    );
}

#[test]
fn escapes_script_terminators_and_comment_openers_in_the_inlined_bundles() {
    let bundle =
        r#"const a = "</script><script>x()</script>"; const b = "<!--"; const c = /<\/SCRIPT/;"#;
    let mut io = files();
    io.bundle = Ok(bundle.to_owned());
    let html = report_with(&[], io);
    assert_eq!(count(&html, r"(?i)</script"), 2);
    assert!(html.contains(r#"const a = "<\/script><script>x()<\/script>""#));
    assert!(html.contains(r#"const b = "\x3C!--""#));
}

#[test]
fn is_byte_identical_for_identical_input_with_reproducible() {
    let at = |now: &str, extra: &[&str]| {
        let mut io = files();
        io.now = Ok(now.to_owned());
        report_with(extra, io)
    };
    let first = at("2020-01-01T00:00:00.000Z", &["--reproducible"]);
    let second = at("2030-06-15T08:30:00.000Z", &["--reproducible"]);
    assert_eq!(first, second);
    assert!(!first.contains("generatedAt"));
    assert!(
        at("2030-06-15T08:30:00.000Z", &[])
            .contains("\"generatedAt\":\"2030-06-15T08:30:00.000Z\"")
    );
}

#[test]
fn gzips_and_base64_encodes_payloads_above_512_kb() {
    let nodes: Vec<String> = (0..900)
        .map(|i| {
            format!(
                "{{\"id\":\"n{i}\",\"label\":\"Node {i}\",\"attrs\":{{\"note\":\"{}{i}\"}}}}",
                "lorem ipsum dolor sit amet ".repeat(12)
            )
        })
        .collect();
    let edges: Vec<String> = (1..900)
        .map(|i| {
            format!(
                "{{\"source\":\"n{i}\",\"target\":\"n{}\",\"predicate\":\"next\"}}",
                i - 1
            )
        })
        .collect();
    let big = format!(
        "{{\"nodes\":[{}],\"edges\":[{}]}}",
        nodes.join(","),
        edges.join(",")
    );
    let r = run_with(
        &[
            "empty.json",
            "big.json",
            "-o",
            "big.html",
            "-q",
            "--reproducible",
        ],
        io().file("empty.json", r#"{"nodes":[],"edges":[]}"#)
            .file("big.json", big),
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
    let html = r.file("big.html");
    assert!(html.contains("data-encoding=\"gzip-base64\""));
    let (encoding, payload) = extract_payload(&html);
    assert_eq!(encoding.as_deref(), Some("gzip-base64"));
    assert_eq!(
        diff_of(&payload)
            .get("nodes")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(900)
    );
    let body = re(r#"data-encoding="gzip-base64">([^<]*)<"#)
        .captures(&html)
        .unwrap()[1]
        .to_owned();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap();
    assert_eq!(bytes[9], 0xff); // a platform-independent gzip header
    assert!(json::to_string(&payload).len() > 512 * 1024);
}

/// Above the layout's large-graph threshold (3,000 nodes) the layout covers only the changes.
fn large() -> MemoryIo {
    let many = |renamed: bool| {
        let nodes: Vec<String> = (0..3200)
            .map(|i| {
                let label = if renamed && i == 7 {
                    "Renamed seven".to_owned()
                } else {
                    format!("Node {i}")
                };
                format!("{{\"id\":\"n{i}\",\"label\":\"{label}\"}}")
            })
            .collect();
        let edges: Vec<String> = (0..3199)
            .map(|i| {
                format!(
                    "{{\"source\":\"n{}\",\"target\":\"n{i}\",\"predicate\":\"next\"}}",
                    i + 1
                )
            })
            .collect();
        format!(
            "{{\"nodes\":[{}],\"edges\":[{}]}}",
            nodes.join(","),
            edges.join(",")
        )
    };
    io().file("big1.json", many(false))
        .file("big2.json", many(true))
}

fn layout_scope(html: &str) -> Option<String> {
    payload_of(html)
        .get("layout")
        .and_then(|l| l.get("scope"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[test]
fn leaves_the_compute_add_on_out_of_reports_whose_layout_covers_the_whole_graph() {
    let html = report(&[]);
    assert!(!html.contains(FAKE_COMPUTE));
    assert_eq!(layout_scope(&html).as_deref(), Some("all"));
}

#[test]
fn inlines_the_compute_add_on_right_after_the_viewer_when_the_layout_covers_only_the_changes() {
    let r = run_with(&["big1.json", "big2.json", "-o", "r.html", "-q"], large());
    assert_eq!(r.code, 0, "{}", r.stderr);
    let html = r.file("r.html");
    assert_eq!(layout_scope(&html).as_deref(), Some("changes"));
    assert!(html.contains(&format!(
        "<script>{FAKE_BUNDLE}</script>\n<script>{FAKE_COMPUTE}</script>\n</body>"
    )));
}

#[test]
fn skips_the_compute_add_on_with_no_compute() {
    let r = run_with(
        &[
            "big1.json",
            "big2.json",
            "-o",
            "r.html",
            "-q",
            "--no-compute",
        ],
        large(),
    );
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(!r.file("r.html").contains(FAKE_COMPUTE));
}

#[test]
fn only_warns_when_the_compute_add_on_is_missing() {
    let mut io = large();
    io.compute = Err("The compute add-on was not found.".to_owned());
    let r = run_with(&["big1.json", "big2.json", "-o", "r.html"], io);
    assert_eq!(r.code, 0);
    assert!(
        r.stderr.contains(
            "warning: The compute add-on was not found. The report is written without it"
        ),
        "{}",
        r.stderr
    );
    assert!(!r.file("r.html").contains(FAKE_COMPUTE));
    // A report that does not need it never asks for it.
    let mut small = files();
    small.compute = Err("The compute add-on was not found.".to_owned());
    let r = run_with(&["v1.json", "v2.json", "-o", "r.html"], small);
    assert!(!r.stderr.contains("warning"), "{}", r.stderr);
}

#[test]
fn renders_html_building_blocks() {
    assert_eq!(
        escape_html("<a href=\"x\">'&'</a>"),
        "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    );
    let text = json::to_string(&json::parse(r#"{"s":"</script><!--  "}"#).unwrap());
    let safe = script_safe_json(&text);
    assert!(!safe.contains('<'));
    assert_eq!(json::parse(&safe).unwrap(), json::parse(&text).unwrap());
    assert_eq!(script_safe_js("\"</SCRIPT>\""), "\"<\\/SCRIPT>\"");
    let payload = json::parse(
        r#"{"format":"kgdiff.report","version":1,"diff":{},"meta":{"generator":"kgdiff 0.0.0","before":{"name":"a"},"after":{"name":"b"}}}"#,
    )
    .unwrap();
    assert!(
        encode_payload(&payload, kgdiff_report::html::GZIP_THRESHOLD)
            .1
            .is_none()
    );
    assert_eq!(encode_payload(&payload, 10).1, Some("gzip-base64"));
    let html = render_report_html(
        &payload,
        ViewerBundles {
            main: "main()",
            compute: Some("x = \"</script>\""),
        },
        "d",
        kgdiff_report::html::GZIP_THRESHOLD,
    );
    assert!(
        html.contains("<script>main()</script>\n<script>x = \"<\\/script>\"</script>\n</body>")
    );
    let plain = || {
        render_report_html(
            &payload,
            ViewerBundles {
                main: "/**/",
                compute: None,
            },
            "d",
            512 * 1024,
        )
    };
    assert_eq!(plain(), plain());
    assert!(
        plain().contains("<title>a → b · kgdiff</title>") && plain().contains("<html lang=\"en\">")
    );
}

#[test]
fn builds_the_ontology_release_report() {
    let d = dataset("ontology-release");
    let r = run_with(&d.argv(&["-o", "r.html", "-q", "--reproducible"]), io());
    assert_eq!(r.code, 0, "{}", r.stderr);
    let payload = payload_of(&r.file("r.html"));
    assert_eq!(
        payload
            .get("diff")
            .and_then(|d| d.get("hunks"))
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(22)
    );
    assert_eq!(
        json::to_string(payload.get("meta").and_then(|m| m.get("before")).unwrap()),
        r#"{"name":"mhd 2026-09-01","format":"obo"}"#
    );
}
