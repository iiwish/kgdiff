//! The HTML report document: the payload script (plain, or gzip + base64 above the threshold),
//! no layout (D-10), the viewer bundle and then the compute add-on, made safe inside `<script>`;
//! and the bundles feature `embed-viewer` compiles in.

use std::io::Read;

use base64::Engine;
use kgdiff_core::js::{Value, json};
use kgdiff_core::{DiffResult, Locale};
use kgdiff_report::html::{PAYLOAD_TYPE, render_report_html, report_payload};
use kgdiff_report::{
    MISSING_VIEWER_HINT, ReportInfo, ReportSide, ViewerBundles, build_report_html, describe_diff,
    embedded_viewer,
};

fn diff() -> DiffResult {
    let graph = |label: &str| {
        json::parse(&format!(
            r#"{{"meta":{{"name":"g"}},"nodes":[{{"id":"a","label":"{label}"}},{{"id":"b","label":"B </script>"}}],"edges":[{{"source":"a","target":"b","type":"knows"}}]}}"#
        ))
        .unwrap()
    };
    let options = kgdiff_core::resolve_options(None).unwrap();
    kgdiff_core::diff(&graph("Ada"), &graph("Ada Lovelace"), &options).unwrap()
}

fn info() -> ReportInfo {
    ReportInfo {
        title: "g 1 → g 2 <i>".to_owned(),
        generator: "kgdiff 9.9.9".to_owned(),
        generated_at: None,
        before: ReportSide {
            name: "g 1".to_owned(),
            format: Some("json".to_owned()),
        },
        after: ReportSide {
            name: "g 2".to_owned(),
            format: Some("json".to_owned()),
        },
        mode: None,
        scope: Some("changes".to_owned()),
        theme: Some("dark".to_owned()),
        locale: Locale::ZhCn,
        panels: None,
    }
}

const STUBS: ViewerBundles<'static> = ViewerBundles {
    main: "/* viewer </script> */",
    compute: Some("/* compute <!-- */"),
};

/// The payload script's attributes and text.
fn payload_script(html: &str) -> (&str, &str) {
    let open = format!("<script type=\"{PAYLOAD_TYPE}\"");
    let start = html.find(&open).unwrap() + open.len();
    let rest = &html[start..];
    let end = rest.find('>').unwrap();
    let close = rest.find("</script>").unwrap();
    (&rest[..end], &rest[end + 1..close])
}

#[test]
fn embeds_the_payload_and_the_bundles() {
    let diff = diff();
    let html = build_report_html(&diff, &info(), STUBS);
    let (attrs, text) = payload_script(&html);
    assert_eq!(attrs, " data-for=\"kgdiff\"");
    let embedded = json::parse(text).unwrap();
    assert_eq!(embedded, report_payload(&diff, &info()));
    assert!(
        embedded.get("layout").is_none(),
        "phase 3 reports carry no layout (D-10)"
    );
    assert_eq!(
        embedded
            .get("view")
            .and_then(|v| v.get("locale"))
            .and_then(Value::as_str),
        Some("zh-CN")
    );
    // The title is escaped, the bundles cannot close their script, and the compute add-on
    // follows the viewer.
    assert!(html.contains("<title>g 1 → g 2 &lt;i&gt; · kgdiff</title>"));
    let viewer = html
        .find("<script>/* viewer <\\/script> */</script>")
        .unwrap();
    let compute = html
        .find("<script>/* compute \\x3C!-- */</script>")
        .unwrap();
    assert!(html.find(PAYLOAD_TYPE).unwrap() < viewer && viewer < compute);
    assert!(html.contains(&format!(
        "<meta name=\"description\" content=\"{}\">",
        describe_diff(&diff, Locale::ZhCn)
    )));
    assert!(
        html.starts_with("<!doctype html>\n<html lang=\"zh-CN\">\n")
            && html.ends_with("</body>\n</html>\n")
    );
}

#[test]
fn compresses_payloads_above_the_threshold() {
    let diff = diff();
    let payload = report_payload(&diff, &info());
    let size = json::to_string(&payload).len();
    let plain = render_report_html(&payload, STUBS, "d", size);
    assert_eq!(payload_script(&plain).0, " data-for=\"kgdiff\"");
    let html = render_report_html(&payload, STUBS, "d", size - 1);
    let (attrs, text) = payload_script(&html);
    assert_eq!(attrs, " data-for=\"kgdiff\" data-encoding=\"gzip-base64\"");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap();
    let mut decoded = String::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_string(&mut decoded)
        .unwrap();
    assert_eq!(json::parse(&decoded).unwrap(), payload);
    assert_eq!(
        html,
        render_report_html(&payload, STUBS, "d", size - 1),
        "reproducible"
    );
}

#[test]
fn embeds_the_viewer_when_built_with_it() {
    match embedded_viewer() {
        Some(bundles) => {
            assert!(bundles.main.contains("kgdiff-viewer"));
            assert!(bundles.compute.is_some_and(|c| c.contains("KgdiffCompute")));
        }
        None => {
            // CI builds the assets before it tests with the feature: there, they must be in.
            assert!(
                !(cfg!(feature = "embed-viewer") && std::env::var_os("CI").is_some()),
                "built with embed-viewer in CI, but the viewer bundles are missing"
            );
            assert!(MISSING_VIEWER_HINT.contains("pnpm build:viewer-assets"));
        }
    }
}
