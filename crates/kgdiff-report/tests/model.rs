//! `packages/cli/test/model.test.ts`, ported: hunk families, glyphs and name-status letters,
//! the overview, apportioning, watched attributes, possible matches and locales. Where the
//! TypeScript tests use a hand-made `DiffResult`, these use real diffs that produce the same
//! situations.

use kgdiff_core::js::json;
use kgdiff_core::{DiffResult, Locale, resolve_options};
use kgdiff_report::locale::{format_int, match_locale, resolve_locale};
use kgdiff_report::model::{
    ChangeFamily, DEFAULT_WATCH_ATTRS, LIST_PHASES, apportion, hunk_family, hunk_glyph,
    name_status, overview, percent, possible_matches, watched_changes,
};

fn diff(before: &str, after: &str, options: &str) -> DiffResult {
    let options = resolve_options(Some(&json::parse(options).unwrap())).unwrap();
    kgdiff_core::diff(
        &json::parse(before).unwrap(),
        &json::parse(after).unwrap(),
        &options,
    )
    .unwrap()
}

fn zoo() -> DiffResult {
    diff(
        r#"{"nodes":[{"id":"thing","label":"Thing"},{"id":"animal","label":"Animal"},{"id":"plant","label":"Plant"},{"id":"cat","label":"Cat"},{"id":"dog","label":"Dog"},{"id":"tree","label":"Tree"},{"id":"gone","label":"Gone"}],"edges":[{"source":"animal","target":"thing","predicate":"is_a"},{"source":"plant","target":"thing","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"tree","target":"animal","predicate":"is_a"},{"source":"gone","target":"thing","predicate":"is_a"},{"source":"cat","target":"dog","predicate":"chases"}]}"#,
        r#"{"nodes":[{"id":"thing","label":"Thing"},{"id":"animal","label":"Animal"},{"id":"plant","label":"Plant"},{"id":"cat","label":"House cat"},{"id":"dog","label":"Dog"},{"id":"tree","label":"Tree"},{"id":"new","label":"New"}],"edges":[{"source":"animal","target":"thing","predicate":"is_a"},{"source":"plant","target":"thing","predicate":"is_a"},{"source":"cat","target":"animal","predicate":"is_a"},{"source":"dog","target":"animal","predicate":"is_a"},{"source":"tree","target":"plant","predicate":"is_a"},{"source":"new","target":"thing","predicate":"is_a"},{"source":"dog","target":"cat","predicate":"chases"}]}"#,
        r#"{"match":{"strategy":"id"},"hierarchyPredicates":["is_a"]}"#,
    )
}

fn hunk<'a>(
    result: &'a DiffResult,
    anchor: &str,
    kind: Option<&str>,
) -> &'a kgdiff_core::model::Hunk {
    result
        .hunks
        .iter()
        .find(|h| h.anchor.as_str() == anchor && kind.is_none_or(|k| h.kind.as_str() == k))
        .unwrap_or_else(|| panic!("no hunk for {anchor}"))
}

#[test]
fn hunk_kinds_have_the_scene_families() {
    // `@kgdiff/scene`'s hunkFamily: the families of docs/visual-language.md.
    let result = zoo();
    let family = |kind: &str| {
        result
            .hunks
            .iter()
            .find(|h| h.kind.as_str() == kind && h.kind.as_str() != "modify")
            .map(hunk_family)
    };
    assert_eq!(family("add"), Some(ChangeFamily::Added));
    assert_eq!(family("remove"), Some(ChangeFamily::Removed));
    if let Some(f) = family("relations") {
        assert_eq!(f, ChangeFamily::Structure);
    }
}

#[test]
fn shows_pure_hierarchy_moves_as_structure() {
    let result = zoo();
    let mv = hunk(&result, "tree", None);
    assert_eq!(mv.kind.as_str(), "modify");
    assert_eq!(mv.phase.as_str(), "restructure");
    assert_eq!(hunk_family(mv), ChangeFamily::Structure);
    assert_eq!(hunk_glyph(mv), "⇄");
    assert_eq!(name_status(mv, &result), "V");
}

#[test]
fn names_renames_additions_and_removals() {
    let result = zoo();
    let rename = hunk(&result, "cat", None);
    assert_eq!(hunk_family(rename), ChangeFamily::Content);
    assert_eq!(hunk_glyph(rename), "~");
    assert_eq!(name_status(rename, &result), "R");
    assert_eq!(name_status(hunk(&result, "new", Some("add")), &result), "A");
    assert_eq!(hunk_glyph(hunk(&result, "new", Some("add"))), "+");
    assert_eq!(
        name_status(hunk(&result, "gone", Some("remove")), &result),
        "D"
    );
    assert_eq!(hunk_glyph(hunk(&result, "gone", Some("remove"))), "−");
    if let Some(relations) = result.hunks.iter().find(|h| h.kind.as_str() == "relations") {
        assert_eq!(name_status(relations, &result), "E");
        assert_eq!(hunk_family(relations), ChangeFamily::Structure);
    }
}

#[test]
fn counts_hunks_and_changed_elements_per_phase() {
    let result = zoo();
    let ov = overview(&result);
    assert_eq!(ov.hunks, result.hunks.len());
    let changed = result
        .nodes
        .iter()
        .filter(|n| n.status.as_str() != "unchanged")
        .count()
        + result
            .edges
            .iter()
            .filter(|e| e.status.as_str() != "unchanged")
            .count();
    assert_eq!(ov.changes, changed);
    assert_eq!(
        LIST_PHASES
            .iter()
            .map(|&p| ov.phase(p).hunks)
            .sum::<usize>(),
        ov.hunks
    );
}

#[test]
fn apportions_proportionally() {
    assert_eq!(apportion(&[1, 1, 2], 8), [2, 2, 4]);
    assert_eq!(apportion(&[0, 3, 0], 5), [0, 5, 0]);
    assert!(apportion(&[], 5).is_empty());
    assert_eq!(apportion(&[1, 2], 0), [0, 0]);
}

#[test]
fn gives_every_non_zero_weight_a_cell_and_fills_exactly_the_total() {
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % n).unwrap()
    };
    for _ in 0..5000 {
        let weights: Vec<usize> = (0..1 + next(6))
            .map(|_| if next(4) == 0 { 0 } else { next(1001) })
            .collect();
        let total = 1 + next(60);
        let cells = apportion(&weights, total);
        let positive = weights.iter().filter(|&&w| w > 0).count();
        if positive == 0 {
            continue;
        }
        assert_eq!(cells.iter().sum::<usize>(), total, "{weights:?} {total}");
        if total >= positive {
            for (w, c) in weights.iter().zip(&cells) {
                if *w > 0 {
                    assert!(*c >= 1, "{weights:?} {total}");
                } else {
                    assert_eq!(*c, 0);
                }
            }
        }
    }
}

fn definitions() -> (String, String) {
    (
        r#"{"nodes":[{"id":"a","label":"A","attrs":{"def":"An a.","comment":"old","note":"x"}},{"id":"b","label":"B","attrs":{"def":"A b."}},{"id":"c","label":"C","attrs":{"skos:definition":"A c.","def":"A c."}},{"id":"gone","label":"Gone","attrs":{"def":"Gone."}}],"edges":[]}"#.to_owned(),
        r#"{"nodes":[{"id":"a","label":"A","attrs":{"def":"An a, reworded.","comment":"new","note":"y"}},{"id":"b","label":"B","attrs":{"def":"A b."}},{"id":"c","label":"C","attrs":{"skos:definition":"A c, reworded.","def":"A c!"}},{"id":"new","label":"New","attrs":{"def":"New."}}],"edges":[]}"#.to_owned(),
    )
}

fn strings(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| (*k).to_owned()).collect()
}

#[test]
fn lists_the_watched_keys_each_hunk_changes_in_watch_order() {
    let (before, after) = definitions();
    let result = diff(&before, &after, "{}");
    let hunk_of = |id: &str| {
        result
            .node(id)
            .and_then(|n| n.hunk.as_ref())
            .map(|h| h.as_str().to_owned())
            .unwrap_or_default()
    };
    let mut watched = watched_changes(&result, &strings(&DEFAULT_WATCH_ATTRS));
    watched.sort();
    let mut expected = vec![
        (hunk_of("a"), strings(&["def"])),
        (hunk_of("c"), strings(&["def", "skos:definition"])),
    ];
    expected.sort();
    assert_eq!(watched, expected);
    let reordered = watched_changes(&result, &strings(&["skos:definition", "def"]));
    assert_eq!(
        reordered
            .iter()
            .find(|(h, _)| *h == hunk_of("c"))
            .map(|(_, k)| k.clone()),
        Some(strings(&["skos:definition", "def"]))
    );
}

#[test]
fn ignores_added_and_removed_nodes_unchanged_values_other_keys_and_ignored_attributes() {
    let (before, after) = definitions();
    let result = diff(&before, &after, "{}");
    let hunk_of = |id: &str| {
        result
            .node(id)
            .and_then(|n| n.hunk.as_ref())
            .map(|h| h.as_str().to_owned())
            .unwrap_or_default()
    };
    let watched = watched_changes(&result, &strings(&["def", "comment"]));
    for id in ["b", "gone", "new"] {
        assert!(!watched.iter().any(|(h, _)| *h == hunk_of(id)), "{id}");
    }
    assert_eq!(
        watched
            .iter()
            .find(|(h, _)| *h == hunk_of("a"))
            .map(|(_, k)| k.clone()),
        Some(strings(&["def", "comment"]))
    );
    assert!(watched_changes(&result, &[]).is_empty());
    let ignored = diff(&before, &after, r#"{"ignoreAttrs":["def"]}"#);
    assert!(watched_changes(&ignored, &strings(&["def"])).is_empty());
}

#[test]
fn keeps_pairings_with_a_removed_or_an_added_side_highest_score_first_then_by_ids() {
    // Two rings whose atoms all tie: every pairing is a suggestion, ordered by ids.
    let ring = |p: &str, bonds: [(u8, u8); 6]| {
        let nodes: Vec<String> = (1..=6)
            .map(|i| format!("{{\"id\":\"{p}{i}\",\"label\":\"C\",\"type\":\"Atom\"}}"))
            .collect();
        let edges: Vec<String> = bonds
            .iter()
            .map(|(s, t)| {
                format!("{{\"source\":\"{p}{s}\",\"target\":\"{p}{t}\",\"predicate\":\"bond\"}}")
            })
            .collect();
        format!(
            "{{\"nodes\":[{}],\"edges\":[{}]}}",
            nodes.join(","),
            edges.join(",")
        )
    };
    let result = diff(
        &ring("h", [(1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 1)]),
        &ring("t", [(1, 2), (2, 3), (3, 1), (4, 5), (5, 6), (6, 4)]),
        r#"{"match":{"strategy":"similarity"}}"#,
    );
    let list = possible_matches(&result);
    assert_eq!(list.len(), 36);
    for pair in list.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        assert!(
            a.score > b.score
                || (a.score == b.score
                    && (&a.before.id, &a.after.id) <= (&b.before.id, &b.after.id))
        );
    }
    assert_eq!(
        (list[0].before.id.as_str(), list[0].after.id.as_str()),
        ("h1", "t1")
    );
}

#[test]
fn names_each_side_as_it_was_in_its_own_version_shortened_to_40_characters() {
    let long = "L".repeat(45);
    let before = format!(
        r#"{{"nodes":[{{"id":"long","label":"{long}"}},{{"id":"x","label":"X"}}],"edges":[{{"source":"long","target":"x","predicate":"p"}}]}}"#
    );
    let after = format!(
        r#"{{"nodes":[{{"id":"fresh","label":"{long}M"}},{{"id":"x","label":"X"}}],"edges":[{{"source":"fresh","target":"x","predicate":"p"}}]}}"#
    );
    let result = diff(
        &before,
        &after,
        r#"{"match":{"strategy":"similarity","threshold":0.999}}"#,
    );
    let list = possible_matches(&result);
    let first = list.first().expect("a possible match");
    assert_eq!(first.before.name, format!("{}…", "L".repeat(39)));
    assert_eq!(first.after.name, format!("{}…", "L".repeat(39)));
    assert!(first.label > 0.0 && first.neighbors > 0.0);
}

#[test]
fn formats_scores_as_whole_percentages() {
    assert_eq!(percent(0.796_297), "80%");
    assert_eq!(percent(0.82), "82%");
    assert_eq!(percent(1.0), "100%");
}

#[test]
fn maps_tags_and_posix_locales() {
    assert_eq!(match_locale("zh_CN.UTF-8"), Some(Locale::ZhCn));
    assert_eq!(match_locale("zh-Hant-TW"), Some(Locale::ZhCn));
    assert_eq!(match_locale("ZH"), Some(Locale::ZhCn));
    assert_eq!(match_locale("en_GB.UTF-8"), Some(Locale::En));
    assert_eq!(match_locale("C"), Some(Locale::En));
    assert_eq!(match_locale("fr_FR"), None);
}

#[test]
fn prefers_the_flag_then_lc_all_lc_messages_and_lang() {
    let env = |vars: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            vars.iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| (*v).to_owned())
        }
    };
    assert_eq!(
        resolve_locale(Some(Locale::En), &env(&[("LANG", "zh_CN.UTF-8")])),
        Locale::En
    );
    assert_eq!(
        resolve_locale(None, &env(&[("LANG", "zh_CN.UTF-8")])),
        Locale::ZhCn
    );
    assert_eq!(
        resolve_locale(
            None,
            &env(&[("LC_ALL", "en_US.UTF-8"), ("LANG", "zh_CN.UTF-8")])
        ),
        Locale::En
    );
    assert_eq!(
        resolve_locale(None, &env(&[("LC_MESSAGES", "zh_TW"), ("LANG", "en_US")])),
        Locale::ZhCn
    );
    assert_eq!(
        resolve_locale(None, &env(&[("LANG", "fr_FR.UTF-8")])),
        Locale::En
    );
    assert_eq!(resolve_locale(None, &env(&[])), Locale::En);
}

#[test]
fn formats_integers_with_thousands_separators() {
    assert_eq!(format_int(0), "0");
    assert_eq!(format_int(1_234_567), "1,234,567");
}
