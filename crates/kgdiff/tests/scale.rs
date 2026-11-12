//! More hunks than JavaScript's call arguments allow
//! (which once threw there) align in `--name-status` and list in full with `--limit 0`.

use kgdiff_core::js::json;
use kgdiff_core::{Locale, resolve_options};
use kgdiff_report::{Painter, TextContext, render_name_status, render_summary};

const HUNKS: usize = 150_000;

#[test]
fn renders_150k_hunks() {
    let nodes: Vec<String> = (0..HUNKS).map(|i| format!("{{\"id\":\"n{i}\"}}")).collect();
    let after = json::parse(&format!("{{\"nodes\":[{}],\"edges\":[]}}", nodes.join(","))).unwrap();
    let before = json::parse("{\"nodes\":[],\"edges\":[]}").unwrap();
    let result = kgdiff_core::diff(&before, &after, &resolve_options(None).unwrap()).unwrap();
    let mut ctx = TextContext::new(Painter::plain(), Locale::En);
    ctx.width = 100;
    ctx.limit = 0;
    ctx.watch = None;
    let aligned = render_name_status(&result, &ctx, true).unwrap();
    let lines: Vec<&str> = kgdiff_core::js::trim_end(&aligned).split('\n').collect();
    assert_eq!(lines.len(), HUNKS);
    assert!(lines.iter().all(|line| line.starts_with("A  n")));
    let summary = render_summary(&result, "wide", &ctx).unwrap();
    assert!(summary.contains("n149999"));
    assert!(!summary.contains("more"));
}
