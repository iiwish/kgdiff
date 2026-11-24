//! The KGCL export: each command, each change KGCL cannot express (a comment), how text and
//! ids are written, and the order. The tests build real diffs, not hand-made `DiffResult`s.
//!
//! The commands are checked against the grammar of INCATools/kgcl
//! (`src/kgcl_schema/grammar/kgcl.lark` at `1849f9cbb3ebb4a5ee0e6c62b11238841eb81d66`) and the
//! released `kgcl-schema` 0.7.0; see the module documentation of `kgdiff_report::kgcl`.

use kgdiff_core::js::json;
use kgdiff_core::{DiffResult, resolve_options};
use kgdiff_report::{Kgcl, KgclOptions, render_kgcl};

fn diff(before: &str, after: &str, options: &str) -> DiffResult {
    let options = resolve_options(Some(&json::parse(options).unwrap())).unwrap();
    kgdiff_core::diff(
        &json::parse(before).unwrap(),
        &json::parse(after).unwrap(),
        &options,
    )
    .unwrap()
}

const BY_ID: &str = r#"{"match":{"strategy":"id"}}"#;

fn graph(nodes: &str, edges: &str) -> String {
    format!(r#"{{"nodes":[{nodes}],"edges":[{edges}]}}"#)
}

fn kgcl_with(before: &str, after: &str, options: &KgclOptions<'_>) -> Kgcl {
    render_kgcl(&diff(before, after, BY_ID), options).unwrap()
}

fn kgcl(before: &str, after: &str) -> Kgcl {
    kgcl_with(before, after, &KgclOptions::new(&[]))
}

fn lines(k: &Kgcl) -> Vec<&str> {
    k.text.lines().collect()
}

fn obo() -> KgclOptions<'static> {
    let mut options = KgclOptions::new(&[]);
    options.obo = true;
    options
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[test]
fn renames_with_single_quoted_labels() {
    let k = kgcl(
        &graph(r#"{"id":"GO:1","label":"nucleus"}"#, ""),
        &graph(r#"{"id":"GO:1","label":"cell nucleus"}"#, ""),
    );
    assert_eq!(k.text, "rename GO:1 from 'nucleus' to 'cell nucleus'\n");
    assert_eq!((k.commands, k.comments), (1, 0));
}

#[test]
fn quotes_cjk_and_double_quotes_as_they_are() {
    let k = kgcl(
        &graph(r#"{"id":"GO:1","label":"细胞核"}"#, ""),
        &graph(r#"{"id":"GO:1","label":"the \"cell\" 核 nucleus"}"#, ""),
    );
    assert_eq!(
        k.text,
        "rename GO:1 from '细胞核' to 'the \"cell\" 核 nucleus'\n"
    );
}

#[test]
fn creates_a_node_with_its_label_synonyms_and_definition() {
    let k = kgcl(
        &graph("", ""),
        &graph(
            r#"{"id":"GO:2","label":"nucleolus","aliases":["核仁"],"attrs":{"def":"A small body.","note":"x"}}"#,
            "",
        ),
    );
    assert_eq!(
        lines(&k),
        [
            "create node GO:2 'nucleolus'",
            "create synonym '核仁' for GO:2",
            "add definition 'A small body.' to GO:2",
            r##"# no KGCL command for these fields of a created node: {"id":"GO:2","attrs":{"note":"x"}}"##,
        ]
    );
    // The comment is part of an exported change, not a change left out.
    assert_eq!(
        (k.commands, k.comments, k.unexported, k.partial),
        (3, 1, 0, 1)
    );
}

#[test]
fn creates_a_node_without_a_label_as_a_class() {
    let k = kgcl(&graph("", ""), &graph(r#"{"id":"GO:3"}"#, ""));
    assert_eq!(k.text, "create GO:3\n");
}

#[test]
fn creates_an_obsolete_node_obsoleted() {
    let k = kgcl(
        &graph(r#"{"id":"GO:9","label":"keep"}"#, ""),
        &graph(
            r#"{"id":"GO:9","label":"keep"},{"id":"GO:4","label":"old","deprecated":true,"replacedBy":["GO:9"]}"#,
            "",
        ),
    );
    assert_eq!(
        lines(&k),
        [
            "create node GO:4 'old'",
            "obsolete GO:4 with replacement GO:9"
        ]
    );
}

#[test]
fn deletes_nodes_and_edges() {
    let k = kgcl(
        &graph(
            r#"{"id":"GO:1","label":"a"},{"id":"GO:2","label":"b"}"#,
            r#"{"source":"GO:2","target":"GO:1","predicate":"part_of"}"#,
        ),
        &graph(r#"{"id":"GO:1","label":"a"}"#, ""),
    );
    assert_eq!(lines(&k), ["delete edge GO:2 part_of GO:1", "delete GO:2"]);
}

#[test]
fn creates_and_deletes_edges() {
    let k = kgcl(
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:1","target":"A:2","predicate":"BFO:0000050"}"#,
        ),
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:2","target":"A:1","predicate":"BFO:0000050"}"#,
        ),
    );
    assert!(
        k.text.contains("delete edge A:1 BFO:0000050 A:2\n"),
        "{}",
        k.text
    );
    assert!(
        k.text.contains("create edge A:2 BFO:0000050 A:1\n"),
        "{}",
        k.text
    );
    assert_eq!(k.comments, 0);
}

#[test]
fn writes_what_a_created_edge_carries_besides_its_triple_as_a_comment() {
    let k = kgcl(
        &graph(r#"{"id":"A:1"},{"id":"A:2"}"#, ""),
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:1","target":"A:2","predicate":"knows","label":"Knows well","attrs":{"since":2020}}"#,
        ),
    );
    assert_eq!(
        lines(&k),
        [
            "create edge A:1 knows A:2",
            r##"# no KGCL command for the label or attributes of a created edge: {"source":"A:1","predicate":"knows","target":"A:2","label":"Knows well","attrs":{"since":2020}}"##,
        ]
    );
}

#[test]
fn moves_a_node_as_a_deleted_and_a_created_edge() {
    // Not `move`: OAK's simpleobo only warns about a NodeMove and its sqldb does not implement it.
    let nodes = r#"{"id":"GO:1","label":"cell part"},{"id":"GO:2","label":"organelle"},{"id":"GO:3","label":"nucleus"}"#;
    let k = kgcl_with(
        &graph(
            nodes,
            r#"{"source":"GO:3","target":"GO:1","predicate":"is_a"}"#,
        ),
        &graph(
            nodes,
            r#"{"source":"GO:3","target":"GO:2","predicate":"is_a"}"#,
        ),
        &obo(),
    );
    assert_eq!(
        lines(&k),
        [
            "delete edge GO:3 rdfs:subClassOf GO:1",
            "create edge GO:3 rdfs:subClassOf GO:2",
        ]
    );
    assert_eq!((k.commands, k.comments), (2, 0));
    // Without OBO's convention the predicate stays as it is.
    let plain = kgcl(
        &graph(
            nodes,
            r#"{"source":"GO:3","target":"GO:1","predicate":"is_a"}"#,
        ),
        &graph(
            nodes,
            r#"{"source":"GO:3","target":"GO:2","predicate":"is_a"}"#,
        ),
    );
    assert_eq!(
        plain.text,
        "delete edge GO:3 is_a GO:1\ncreate edge GO:3 is_a GO:2\n"
    );
}

#[test]
fn writes_a_change_of_several_parents_as_edges() {
    let nodes = r#"{"id":"P:1"},{"id":"P:2"},{"id":"P:3"},{"id":"C:1"}"#;
    let k = kgcl(
        &graph(
            nodes,
            r#"{"source":"C:1","target":"P:1","predicate":"is_a"}"#,
        ),
        &graph(
            nodes,
            r#"{"source":"C:1","target":"P:2","predicate":"is_a"},{"source":"C:1","target":"P:3","predicate":"is_a"}"#,
        ),
    );
    assert_eq!(
        lines(&k),
        [
            "delete edge C:1 is_a P:1",
            "create edge C:1 is_a P:2",
            "create edge C:1 is_a P:3",
        ]
    );
}

#[test]
fn obsoletes_with_a_replacement() {
    let k = kgcl(
        &graph(r#"{"id":"GO:1","label":"a"},{"id":"GO:2","label":"b"}"#, ""),
        &graph(
            r#"{"id":"GO:1","label":"a","deprecated":true,"replacedBy":["GO:2"]},{"id":"GO:2","label":"b"}"#,
            "",
        ),
    );
    assert_eq!(k.text, "obsolete GO:1 with replacement GO:2\n");
}

#[test]
fn obsoletes_and_unobsoletes() {
    let k = kgcl(
        &graph(
            r#"{"id":"GO:1","label":"a"},{"id":"GO:2","label":"b","deprecated":true}"#,
            "",
        ),
        &graph(
            r#"{"id":"GO:1","label":"a","deprecated":true},{"id":"GO:2","label":"b"}"#,
            "",
        ),
    );
    assert_eq!(lines(&k), ["obsolete GO:1", "unobsolete GO:2"]);
}

#[test]
fn creates_and_removes_synonyms() {
    let k = kgcl(
        &graph(r#"{"id":"GO:1","label":"a","aliases":["old","kept"]}"#, ""),
        &graph(r#"{"id":"GO:1","label":"a","aliases":["kept","new"]}"#, ""),
    );
    assert_eq!(
        lines(&k),
        [
            "remove synonym 'old' for GO:1",
            "create synonym 'new' for GO:1"
        ]
    );
}

#[test]
fn qualifies_obo_synonyms_with_their_scope() {
    let before = graph(
        r#"{"id":"GO:1","label":"a","aliases":["x"],"attrs":{"synonyms":["x (EXACT)"]}}"#,
        "",
    );
    let after = graph(
        r#"{"id":"GO:1","label":"a","aliases":["n","x","y"],"attrs":{"synonyms":["n (NARROW)","x (EXACT)","y (RELATED)"]}}"#,
        "",
    );
    let k = kgcl_with(&before, &after, &obo());
    // The `synonyms` attribute changed as the aliases did: it is accounted for.
    assert_eq!(
        lines(&k),
        [
            "create narrow synonym 'n' for GO:1",
            "create related synonym 'y' for GO:1"
        ]
    );
    // Without OBO's convention the attribute is an attribute change like any other.
    let plain = kgcl(&before, &after);
    assert_eq!(plain.comments, 1);
    assert!(plain.text.contains("create synonym 'n' for GO:1\n"));
}

#[test]
fn keeps_a_synonym_scope_change_as_a_comment() {
    let k = kgcl_with(
        &graph(
            r#"{"id":"GO:1","label":"a","aliases":["x"],"attrs":{"synonyms":["x (EXACT)"]}}"#,
            "",
        ),
        &graph(
            r#"{"id":"GO:1","label":"a","aliases":["x"],"attrs":{"synonyms":["x (BROAD)"]}}"#,
            "",
        ),
        &obo(),
    );
    assert_eq!(
        k.text,
        "# no KGCL command for an attribute change: {\"op\":\"node.attr\",\"id\":\"GO:1\",\"key\":\"synonyms\",\"from\":[\"x (EXACT)\"],\"to\":[\"x (BROAD)\"]}\n"
    );
}

#[test]
fn adds_changes_and_removes_definitions() {
    let k = kgcl(
        &graph(
            r#"{"id":"A:1","attrs":{"def":"Old."}},{"id":"A:2"},{"id":"A:3","attrs":{"IAO:0000115":"Gone."}}"#,
            "",
        ),
        &graph(
            r#"{"id":"A:1","attrs":{"def":"New."}},{"id":"A:2","attrs":{"skos:definition":"Added."}},{"id":"A:3"}"#,
            "",
        ),
    );
    let mut got = lines(&k);
    got.sort();
    assert_eq!(
        got,
        [
            "add definition 'Added.' to A:2",
            "change definition of A:1 from 'Old.' to 'New.'",
            "remove definition for A:3",
        ]
    );
}

#[test]
fn writes_node_types_as_rdf_type_edges_for_rdf() {
    let before = graph(r#"{"id":"ex:a","types":["owl:Class"]}"#, "");
    let after = graph(r#"{"id":"ex:a","types":["rdfs:Class"]}"#, "");
    let mut rdf = KgclOptions::new(&[]);
    rdf.rdf_types = true;
    assert_eq!(
        lines(&kgcl_with(&before, &after, &rdf)),
        [
            "delete edge ex:a rdf:type owl:Class",
            "create edge ex:a rdf:type rdfs:Class"
        ]
    );
    let k = kgcl(&before, &after);
    assert_eq!(
        k.text,
        "# no KGCL command for a type change: {\"op\":\"node.set\",\"id\":\"ex:a\",\"field\":\"types\",\"from\":[\"owl:Class\"],\"to\":[\"rdfs:Class\"]}\n"
    );
    // A created node's types, and OBO's stanza type, which `create node` implies.
    let created = graph(r#"{"id":"ex:b","label":"B","types":["owl:Class"]}"#, "");
    assert_eq!(
        lines(&kgcl_with(&graph("", ""), &created, &rdf)),
        [
            "create node ex:b 'B'",
            "create edge ex:b rdf:type owl:Class"
        ]
    );
    let term = graph(r#"{"id":"GO:1","label":"B","types":["Term"]}"#, "");
    assert_eq!(
        kgcl_with(&graph("", ""), &term, &obo()).text,
        "create node GO:1 'B'\n"
    );
}

// ─── Changes KGCL cannot express ─────────────────────────────────────────────

#[test]
fn writes_attribute_changes_as_comments() {
    let k = kgcl(
        &graph(r#"{"id":"A:1","attrs":{"xref":["X:1"],"comment":"a"}}"#, ""),
        &graph(r#"{"id":"A:1","attrs":{"xref":["X:1","X:2"]}}"#, ""),
    );
    assert_eq!(
        lines(&k),
        [
            r##"# no KGCL command for an attribute change: {"op":"node.attr","id":"A:1","key":"comment","from":"a"}"##,
            r##"# no KGCL command for an attribute change: {"op":"node.attr","id":"A:1","key":"xref","from":["X:1"],"to":["X:1","X:2"]}"##,
        ]
    );
    assert_eq!((k.commands, k.comments), (0, 2));
}

#[test]
fn writes_a_definition_that_is_not_one_text_as_a_comment() {
    let k = kgcl(
        &graph(r#"{"id":"A:1","attrs":{"def":"a"}}"#, ""),
        &graph(r#"{"id":"A:1","attrs":{"def":["a","b"]}}"#, ""),
    );
    assert!(
        k.text
            .starts_with("# no KGCL command for a definition that is not a single text: "),
        "{}",
        k.text
    );
}

#[test]
fn writes_edge_label_and_attribute_changes_as_comments() {
    let k = kgcl(
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:1","target":"A:2","predicate":"r","label":"R","attrs":{"w":1}}"#,
        ),
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:1","target":"A:2","predicate":"r","label":"Related","attrs":{"w":2}}"#,
        ),
    );
    let got = lines(&k);
    assert_eq!(got.len(), 2, "{}", k.text);
    assert!(got.iter().any(|l| {
        l.starts_with("# no KGCL command for an edge label change: {\"op\":\"edge.set\"")
    }));
    assert!(got.iter().any(|l| {
        l.starts_with("# no KGCL command for an edge attribute change: {\"op\":\"edge.attr\"")
    }));
}

#[test]
fn writes_an_id_change_as_a_comment() {
    let k = render_kgcl(
        &diff(
            &graph(r#"{"id":"A:1","label":"Ada"}"#, ""),
            &graph(r#"{"id":"A:2","label":"Ada","replaces":["A:1"]}"#, ""),
            r#"{"match":{"strategy":"auto"}}"#,
        ),
        &KgclOptions::new(&[]),
    )
    .unwrap();
    assert!(
        k.text
            .starts_with("# no KGCL command for an id change, so it is not exported and the commands below use the old id: {\"op\":\"node.rekey\",\"from\":\"A:1\",\"to\":\"A:2\"}\n"),
        "{}",
        k.text
    );
    // `replaces` is not a deprecation either.
    assert!(
        k.text.contains("# no KGCL command for a replaces change: "),
        "{}",
        k.text
    );
}

#[test]
fn writes_replaced_by_without_obsoletion_as_a_comment() {
    let k = kgcl(
        &graph(r#"{"id":"A:1","deprecated":true},{"id":"A:2"}"#, ""),
        &graph(
            r#"{"id":"A:1","deprecated":true,"replacedBy":["A:2"]},{"id":"A:2"}"#,
            "",
        ),
    );
    // kgdiff reads the new `replacedBy` as a merge, which is not an obsoletion here either.
    assert_eq!(
        lines(&k),
        [
            r##"# no KGCL command for a merge that is not an obsoletion with replacement: {"hunk":"merge:A:2","node":"A:1","into":"A:2"}"##,
            r##"# no KGCL command for a replacedBy change without obsoletion: {"op":"node.set","id":"A:1","field":"replacedBy","from":[],"to":["A:2"]}"##,
        ]
    );
}

#[test]
fn notes_a_split_before_its_changes() {
    let k = render_kgcl(
        &diff(
            &graph(r#"{"id":"A:1","label":"whole"}"#, ""),
            &graph(
                r#"{"id":"A:1","label":"whole","deprecated":true},{"id":"A:2","label":"part one","replaces":["A:1"]},{"id":"A:3","label":"part two","replaces":["A:1"]}"#,
                "",
            ),
            r#"{"match":{"strategy":"auto"}}"#,
        ),
        &KgclOptions::new(&[]),
    )
    .unwrap();
    let got = lines(&k);
    assert_eq!(
        got[0],
        r##"# no KGCL command for a split; its changes follow: {"hunk":"split:A:1","node":"A:1","into":["A:2","A:3"]}"##,
        "{}",
        k.text
    );
    assert!(got.contains(&"obsolete A:1"));
    assert!(got.contains(&"create node A:2 'part one'"));
    // The note is not a change left out: the split's own changes are exported or commented.
    let commented = got.iter().filter(|l| l.starts_with('#')).count();
    assert_eq!(k.comments, commented);
    assert_eq!(k.unexported + k.partial, commented - 1, "{}", k.text);
}

#[test]
fn notes_a_merge_that_is_not_an_obsoletion() {
    let k = render_kgcl(
        &diff(
            &graph(
                r#"{"id":"A:1","label":"one"},{"id":"A:2","label":"two"}"#,
                "",
            ),
            &graph(r#"{"id":"A:2","label":"two","replaces":["A:1"]}"#, ""),
            r#"{"match":{"strategy":"auto"}}"#,
        ),
        &KgclOptions::new(&[]),
    )
    .unwrap();
    assert!(
        k.text.starts_with(
            r##"# no KGCL command for a merge that is not an obsoletion with replacement: {"hunk":"merge:A:2","node":"A:1","into":"A:2"}"##
        ),
        "{}",
        k.text
    );
    assert!(k.text.contains("delete A:1\n"), "{}", k.text);
}

#[test]
fn writes_implicit_nodes_as_comments() {
    let k = kgcl(
        &graph(r#"{"id":"A:1"}"#, ""),
        &graph(
            r#"{"id":"A:1"}"#,
            r#"{"source":"A:1","target":"EXT:9","predicate":"r"}"#,
        ),
    );
    assert_eq!(
        lines(&k),
        [
            r##"# no KGCL command for a node the file does not declare (an edge endpoint only): {"op":"node.add","node":{"id":"EXT:9","implicit":true}}"##,
            "create edge A:1 r EXT:9",
        ]
    );
}

#[test]
fn writes_text_kgcl_cannot_quote_as_a_comment() {
    // A single quote, a newline and the other line breaks of Python's `splitlines`.
    for label in [
        "Alzheimer's disease",
        "two\\nlines",
        "a\\u2028b",
        "c\\u000bd",
    ] {
        let k = kgcl(
            &graph(r#"{"id":"A:1","label":"plain"}"#, ""),
            &graph(&format!(r#"{{"id":"A:1","label":"{label}"}}"#), ""),
        );
        assert!(
            k.text.starts_with(
                "# KGCL cannot quote this text (empty, or with a ' or a line break): {\"op\":\"node.set\""
            ),
            "{label}: {}",
            k.text
        );
        // The comment stays on one line.
        assert_eq!(k.text.lines().count(), 1, "{label}: {:?}", k.text);
        assert_eq!((k.commands, k.comments, k.unexported), (0, 1, 1));
    }
    // `rename` needs the old label as well: KGCL has no form without it.
    let k = kgcl(
        &graph(r#"{"id":"A:1","label":"it's"}"#, ""),
        &graph(r#"{"id":"A:1","label":"its"}"#, ""),
    );
    assert!(
        k.text.starts_with("# KGCL cannot quote this text"),
        "{}",
        k.text
    );
    // A synonym, and a created node's label (the node is still created).
    let k = kgcl(
        &graph(r#"{"id":"A:1","label":"a"}"#, ""),
        &graph(
            r#"{"id":"A:1","label":"a","aliases":["it's"]},{"id":"A:2","label":"b's"}"#,
            "",
        ),
    );
    assert_eq!(
        lines(&k),
        [
            r##"# KGCL cannot quote this text (empty, or with a ' or a line break): {"op":"node.set","id":"A:1","field":"aliases","added":"it's"}"##,
            "create A:2",
            r##"# no KGCL command for these fields of a created node: {"id":"A:2","label":"b's"}"##,
        ]
    );
}

#[test]
fn keeps_comment_lines_whole_with_unescaped_json_line_separators() {
    let k = kgcl(
        &graph(r#"{"id":"A:1","attrs":{"note":"a"}}"#, ""),
        &graph(r#"{"id":"A:1","attrs":{"note":"x y z\u0085w\nv"}}"#, ""),
    );
    assert_eq!(
        k.text,
        "# no KGCL command for an attribute change: {\"op\":\"node.attr\",\"id\":\"A:1\",\"key\":\"note\",\"from\":\"a\",\"to\":\"x\\u2028y\\u2029z\\u0085w\\nv\"}\n"
    );
}

// ─── Ids ─────────────────────────────────────────────────────────────────────

#[test]
fn writes_ids_as_kgcl_allows_and_comments_the_rest() {
    let prefixes = vec![("ex".to_owned(), "http://example.org/".to_owned())];
    let options = KgclOptions::new(&prefixes);
    let nodes = |label: &str| {
        graph(
            &format!(
                r#"{{"id":"http://example.org/a","label":"{label}"}},{{"id":"http://example.org/vocab/b#x","label":"{label}"}},{{"id":"https://w3id.org/z","label":"{label}"}},{{"id":"http://purl.obolibrary.org/obo/GO_0005634","label":"{label}"}},{{"id":"plain_id","label":"{label}"}},{{"id":"has space","label":"{label}"}},{{"id":"'quoted","label":"{label}"}},{{"id":"urn:isbn:1","label":"{label}"}}"#
            ),
            "",
        )
    };
    let k = kgcl_with(&nodes("a"), &nodes("b"), &options);
    let mut got = lines(&k);
    got.sort();
    assert_eq!(
        got,
        [
            r##"# KGCL cannot write this id or predicate: {"op":"node.set","id":"'quoted","field":"label","from":"a","to":"b"}"##,
            r##"# KGCL cannot write this id or predicate: {"op":"node.set","id":"has space","field":"label","from":"a","to":"b"}"##,
            "rename <https://w3id.org/z> from 'a' to 'b'",
            "rename <urn:isbn:1> from 'a' to 'b'",
            "rename GO:0005634 from 'a' to 'b'",
            "rename ex:a from 'a' to 'b'",
            "rename ex:vocab/b#x from 'a' to 'b'",
            "rename plain_id from 'a' to 'b'",
        ]
    );
}

#[test]
fn prefers_the_longest_namespace() {
    let prefixes = vec![
        ("ex".to_owned(), "http://example.org/".to_owned()),
        ("exv".to_owned(), "http://example.org/vocab/".to_owned()),
        (
            "bad-name".to_owned(),
            "http://example.org/vocab/deep/".to_owned(),
        ),
    ];
    let options = KgclOptions::new(&prefixes);
    let k = kgcl_with(
        &graph(
            r#"{"id":"http://example.org/vocab/deep/b","label":"a"}"#,
            "",
        ),
        &graph(
            r#"{"id":"http://example.org/vocab/deep/b","label":"b"}"#,
            "",
        ),
        &options,
    );
    assert_eq!(k.text, "rename exv:deep/b from 'a' to 'b'\n");
}

#[test]
fn comments_ids_kgcl_cannot_write() {
    let prefixes = vec![("ex".to_owned(), "http://example.org/".to_owned())];
    let options = KgclOptions::new(&prefixes);
    let ids = [
        "\\\"quoted",
        "<angle",
        "http://example.org/a>>b",
        "https://w3id.org/a>b",
        "a\\u00a0b",
        "x:\\u3000y",
    ];
    let nodes = |label: &str| {
        let list: Vec<String> = ids
            .iter()
            .map(|id| format!(r#"{{"id":"{id}","label":"{label}"}}"#))
            .collect();
        graph(&list.join(","), "")
    };
    let k = kgcl_with(&nodes("a"), &nodes("b"), &options);
    assert_eq!((k.commands, k.comments), (0, ids.len()), "{}", k.text);
    assert!(
        lines(&k)
            .iter()
            .all(|l| l.starts_with("# KGCL cannot write this id or predicate: ")),
        "{}",
        k.text
    );
    // A `>` inside a CURIE's local part is fine; only `>>` and the angle brackets are not.
    let k = kgcl_with(
        &graph(r#"{"id":"http://example.org/a>b","label":"a"}"#, ""),
        &graph(r#"{"id":"http://example.org/a>b","label":"b"}"#, ""),
        &options,
    );
    assert_eq!(k.text, "rename ex:a>b from 'a' to 'b'\n");
}

#[test]
fn writes_ids_that_look_like_keywords_as_they_are() {
    // kgcl-schema 0.7.0 and the grammar at 1849f9c read each of these lines back with the
    // keyword-like id in its place.
    let words = ["with", "from", "to", "edge", "node"];
    let nodes: Vec<String> = words
        .iter()
        .map(|w| format!(r#"{{"id":"{w}","label":"L {w}"}}"#))
        .collect();
    let before = graph(
        &nodes.join(","),
        r#"{"source":"with","target":"to","predicate":"from"}"#,
    );
    let after = graph(
        &format!(r#"{},{{"id":"node","label":"L2"}}"#, nodes[..4].join(",")),
        r#"{"source":"edge","target":"node","predicate":"with"}"#,
    );
    let k = kgcl(&before, &after);
    let mut got = lines(&k);
    got.sort();
    assert_eq!(
        got,
        [
            "create edge edge with node",
            "delete edge with from to",
            "rename node from 'L node' to 'L2'",
        ],
        "{}",
        k.text
    );
}

// ─── Id changes ──────────────────────────────────────────────────────────────

fn auto(before: &str, after: &str, options: &KgclOptions<'_>) -> Kgcl {
    render_kgcl(
        &diff(before, after, r#"{"match":{"strategy":"auto"}}"#),
        options,
    )
    .unwrap()
}

#[test]
fn writes_the_changes_after_an_id_change_with_the_old_ids() {
    // A:1 becomes A:2 (`replaces`), is renamed and moved, and B:1 is obsoleted in its favour.
    // KGCL cannot change an id, so every command names it A:1, as the before file does.
    let before = graph(
        r#"{"id":"A:1","label":"Ada"},{"id":"B:1","label":"Bea"},{"id":"P:1","label":"p1"},{"id":"P:2","label":"p2"}"#,
        r#"{"source":"A:1","target":"P:1","predicate":"is_a"},{"source":"B:1","target":"A:1","predicate":"knows"}"#,
    );
    let after = graph(
        r#"{"id":"A:2","label":"Ada L","replaces":["A:1"]},{"id":"B:1","label":"Bea","deprecated":true,"replacedBy":["A:2"]},{"id":"P:1","label":"p1"},{"id":"P:2","label":"p2"}"#,
        r#"{"source":"A:2","target":"P:2","predicate":"is_a"},{"source":"B:1","target":"A:2","predicate":"likes"}"#,
    );
    let k = auto(&before, &after, &KgclOptions::new(&[]));
    let got = lines(&k);
    assert!(
        got[0].starts_with(
            r##"# no KGCL command for an id change, so it is not exported and the commands below use the old id: {"op":"node.rekey","from":"A:1","to":"A:2"}"##
        ),
        "{}",
        k.text
    );
    let commands: Vec<&str> = got
        .iter()
        .copied()
        .filter(|l| !l.starts_with('#'))
        .collect();
    for expected in [
        "delete edge A:1 is_a P:1",
        "create edge A:1 is_a P:2",
        "delete edge B:1 knows A:1",
        "create edge B:1 likes A:1",
        "rename A:1 from 'Ada' to 'Ada L'",
        "obsolete B:1 with replacement A:1",
    ] {
        assert!(commands.contains(&expected), "{expected}: {}", k.text);
    }
    assert!(commands.iter().all(|l| !l.contains("A:2")), "{}", k.text);
    // The comments keep the operations as they are, with the new id.
    assert!(
        k.text
            .contains(r#"{"op":"node.set","id":"A:2","field":"replaces","from":[],"to":["A:1"]}"#),
        "{}",
        k.text
    );
}

#[test]
fn comments_a_new_node_that_takes_the_old_id_of_a_renamed_one() {
    // Matched by their labels, A:1 becomes B:9 and a new node takes the id A:1: in the before
    // file that id is the renamed node's, which the commands keep calling A:1.
    let before = graph(r#"{"id":"A:1","label":"Ada Lovelace"}"#, "");
    let after = graph(
        r#"{"id":"B:9","label":"Ada Lovelace"},{"id":"A:1","label":"Zed"}"#,
        r#"{"source":"A:1","target":"B:9","predicate":"r"}"#,
    );
    let k = render_kgcl(
        &diff(&before, &after, r#"{"match":{"strategy":"similarity"}}"#),
        &KgclOptions::new(&[]),
    )
    .unwrap();
    let got = lines(&k);
    assert!(
        got[0].starts_with(
            r##"# no KGCL command for an id change, so it is not exported and the commands below use the old id: {"op":"node.rekey","from":"A:1","to":"B:9"}"##
        ),
        "{}",
        k.text
    );
    assert_eq!(k.commands, 0, "{}", k.text);
    let clash =
        "# KGCL cannot write this id: in the before file it is the old id of a renamed node: ";
    assert!(
        got.iter()
            .any(|l| l.starts_with(clash) && l.contains(r#""op":"node.add""#)),
        "{}",
        k.text
    );
    assert!(
        got.iter()
            .any(|l| l.starts_with(clash) && l.contains(r#""op":"edge.add""#)),
        "{}",
        k.text
    );
}

// ─── OBO clauses, parallel edges and ignored attributes ─────────────────────

fn parse_obo(text: &str) -> String {
    let mut options = kgdiff_formats::ParseOptions::default();
    options.format = Some(kgdiff_formats::FormatId::Obo);
    let parsed = kgdiff_formats::parse_graph(text, &options).unwrap();
    json::to_string(&kgdiff_core::js::Value::Object(parsed.graph))
}

#[test]
fn writes_only_is_a_and_relationship_clauses_of_obo_as_edges() {
    let terms = "[Term]\nid: X:2\nname: two\n\n[Term]\nid: X:3\nname: three\n\n[Typedef]\nid: part_of\nname: part of\n";
    let before = parse_obo(&format!(
        "format-version: 1.2\n\n[Term]\nid: X:1\nname: one\n\n{terms}"
    ));
    let after = parse_obo(&format!(
        "format-version: 1.2\n\n[Term]\nid: X:1\nname: one\nis_a: X:2\nintersection_of: X:2\nintersection_of: part_of X:3\nunion_of: X:3\ndisjoint_from: X:3\nequivalent_to: X:2\nrelationship: part_of X:3\n\n{terms}"
    ));
    let k = kgcl_with(&before, &after, &obo());
    let got = lines(&k);
    let commands: Vec<&str> = got
        .iter()
        .copied()
        .filter(|l| !l.starts_with('#'))
        .collect();
    assert_eq!(
        commands,
        [
            "create edge X:1 rdfs:subClassOf X:2",
            "create edge X:1 part_of X:3",
        ],
        "{}",
        k.text
    );
    let skipped = |predicate: &str| {
        got.iter().any(|l| {
            l.starts_with("# no KGCL command for an OBO clause that is not is_a or relationship: ")
                && l.contains(&format!(r#""predicate":"{predicate}""#))
        })
    };
    for predicate in ["disjoint_from", "equivalent_to", "union_of"] {
        assert!(skipped(predicate), "{predicate}: {}", k.text);
    }
    // Both `intersection_of` clauses, the genus and the differentia.
    assert_eq!(
        got.iter()
            .filter(|l| l.contains(r#""predicate":"intersection_of""#))
            .count(),
        2,
        "{}",
        k.text
    );
    assert_eq!((k.commands, k.unexported), (2, 5), "{}", k.text);
    // `instance_of`, in an [Instance] stanza.
    let instance = |extra: &str| {
        parse_obo(&format!(
            "format-version: 1.2\n\n[Instance]\nid: I:1\nname: it\n{extra}\n{terms}"
        ))
    };
    let k = kgcl_with(&instance(""), &instance("instance_of: X:2\n"), &obo());
    assert!(
        k.text
            .starts_with("# no KGCL command for an OBO clause that is not is_a or relationship: "),
        "{}",
        k.text
    );
    assert_eq!(k.commands, 0, "{}", k.text);
    // Outside OBO a predicate named so is an edge like any other.
    let plain = kgcl(
        &graph(r#"{"id":"A:1"},{"id":"A:2"}"#, ""),
        &graph(
            r#"{"id":"A:1"},{"id":"A:2"}"#,
            r#"{"source":"A:1","target":"A:2","predicate":"disjoint_from"}"#,
        ),
    );
    assert_eq!(plain.text, "create edge A:1 disjoint_from A:2\n");
}

fn by_edge_id(before: &str, after: &str) -> Kgcl {
    render_kgcl(
        &diff(
            before,
            after,
            r#"{"match":{"strategy":"id"},"edgeIdentity":"id"}"#,
        ),
        &KgclOptions::new(&[]),
    )
    .unwrap()
}

#[test]
fn comments_a_parallel_edge_whose_triple_stays_or_was_there() {
    let nodes = r#"{"id":"A:1"},{"id":"A:2"}"#;
    let e1 = r#"{"id":"e1","source":"A:1","target":"A:2","predicate":"r"}"#;
    let e2 = r#"{"id":"e2","source":"A:1","target":"A:2","predicate":"r"}"#;
    let both = graph(nodes, &format!("{e1},{e2}"));
    let one = graph(nodes, e1);
    // Removing one of two copies: `delete edge A:1 r A:2` would remove the triple the after graph
    // still has.
    let k = by_edge_id(&both, &one);
    assert_eq!((k.commands, k.unexported), (0, 1), "{}", k.text);
    assert!(
        k.text.starts_with(
            "# KGCL cannot remove this edge alone: an edge with the same source, predicate and target remains: "
        ),
        "{}",
        k.text
    );
    // Adding a second copy: `create edge` would add nothing.
    let k = by_edge_id(&one, &both);
    assert_eq!((k.commands, k.unexported), (0, 1), "{}", k.text);
    assert!(
        k.text.starts_with(
            "# KGCL cannot add this edge: an edge with the same source, predicate and target is there already: "
        ),
        "{}",
        k.text
    );
    // Removing both copies: one command, and the second copy is a comment.
    let k = by_edge_id(&both, &graph(nodes, ""));
    assert_eq!(lines(&k)[0], "delete edge A:1 r A:2", "{}", k.text);
    assert_eq!((k.commands, k.unexported), (1, 1), "{}", k.text);
    let k = by_edge_id(&graph(nodes, ""), &both);
    assert_eq!((k.commands, k.unexported), (1, 1), "{}", k.text);
}

#[test]
fn exports_the_changes_of_ignored_attributes_as_the_delta_does() {
    // `--ignore-attr` hides a change from the diff; the delta, and so the KGCL that is applied to
    // the before file, still carries it.
    let before = graph(
        r#"{"id":"A:1","label":"a","attrs":{"def":"Old.","note":"x"}}"#,
        "",
    );
    let after = graph(
        r#"{"id":"A:1","label":"b","attrs":{"def":"New.","note":"y"}}"#,
        "",
    );
    let k = render_kgcl(
        &diff(
            &before,
            &after,
            r#"{"match":{"strategy":"id"},"ignoreAttrs":["def","note"]}"#,
        ),
        &KgclOptions::new(&[]),
    )
    .unwrap();
    let got = lines(&k);
    assert!(
        got.contains(&"change definition of A:1 from 'Old.' to 'New.'"),
        "{}",
        k.text
    );
    assert!(got.contains(&"rename A:1 from 'a' to 'b'"), "{}", k.text);
    assert!(
        got.iter().any(
            |l| l.starts_with("# no KGCL command for an attribute change: ")
                && l.contains(r#""key":"note""#)
        ),
        "{}",
        k.text
    );
}

#[test]
fn removes_or_changes_a_definition_whose_old_text_cannot_be_quoted() {
    let k = kgcl(
        &graph(
            r#"{"id":"A:1","attrs":{"def":"It's old."}},{"id":"A:2","attrs":{"def":"It's gone."}},{"id":"A:3","attrs":{"def":"Old."}}"#,
            "",
        ),
        &graph(
            r#"{"id":"A:1","attrs":{"def":"New."}},{"id":"A:2"},{"id":"A:3","attrs":{"def":"It's new."}}"#,
            "",
        ),
    );
    let mut got = lines(&k);
    got.sort();
    assert_eq!(
        got,
        [
            r##"# KGCL cannot quote this text (empty, or with a ' or a line break): {"op":"node.attr","id":"A:3","key":"def","from":"Old.","to":"It's new."}"##,
            "change definition of A:1 to 'New.'",
            "remove definition for A:2",
        ]
    );
}

// ─── Order and determinism ───────────────────────────────────────────────────

#[test]
fn creates_a_replacement_before_obsoleting_in_its_favour() {
    // A:1 is merged into the new N:1: the merge hunk holds both, and `obsolete … with replacement
    // N:1` comes after `create node N:1`.
    let k = kgcl(
        &graph(r#"{"id":"A:1","label":"a"}"#, ""),
        &graph(
            r#"{"id":"A:1","label":"a","deprecated":true,"replacedBy":["N:1"]},{"id":"N:1","label":"n"}"#,
            "",
        ),
    );
    let got = lines(&k);
    let at = |line: &str| got.iter().position(|l| *l == line);
    let (Some(create), Some(obsolete)) = (
        at("create node N:1 'n'"),
        at("obsolete A:1 with replacement N:1"),
    ) else {
        panic!("{}", k.text);
    };
    assert!(create < obsolete, "{}", k.text);
    assert_eq!(
        got.iter().filter(|l| l.starts_with("create node")).count(),
        1
    );
    // The same for a node created obsolete in favour of another new node.
    let k = kgcl(
        &graph("", ""),
        &graph(
            r#"{"id":"N:2","label":"old","deprecated":true,"replacedBy":["N:3"]},{"id":"N:3","label":"new"}"#,
            "",
        ),
    );
    let got = lines(&k);
    let at = |line: &str| got.iter().position(|l| *l == line);
    let (Some(create), Some(obsolete)) = (
        at("create node N:3 'new'"),
        at("obsolete N:2 with replacement N:3"),
    ) else {
        panic!("{}", k.text);
    };
    assert!(create < obsolete, "{}", k.text);
    assert_eq!(
        got.iter().filter(|l| l.starts_with("create node")).count(),
        2
    );
}

#[test]
fn follows_the_hunk_order_and_is_deterministic() {
    let before = graph(
        r#"{"id":"A:1","label":"a"},{"id":"A:2","label":"b"},{"id":"A:3","label":"c"}"#,
        r#"{"source":"A:1","target":"A:2","predicate":"r"}"#,
    );
    let after = graph(
        r#"{"id":"A:1","label":"a2"},{"id":"A:3","label":"c"},{"id":"A:4","label":"d"}"#,
        r#"{"source":"A:4","target":"A:3","predicate":"r"}"#,
    );
    let result = diff(&before, &after, BY_ID);
    let first = render_kgcl(&result, &KgclOptions::new(&[])).unwrap();
    let again = render_kgcl(&diff(&before, &after, BY_ID), &KgclOptions::new(&[])).unwrap();
    assert_eq!(first, again);
    // Each hunk's lines come in hunk order: removals, then the rename, then the additions.
    assert_eq!(
        lines(&first),
        [
            "delete edge A:1 r A:2",
            "delete A:2",
            "rename A:1 from 'a' to 'a2'",
            "create node A:4 'd'",
            "create edge A:4 r A:3",
        ]
    );
}

#[test]
fn writes_nothing_for_identical_graphs() {
    let g = graph(r#"{"id":"A:1","label":"a"}"#, "");
    let k = kgcl(&g, &g);
    assert_eq!((k.text.as_str(), k.commands, k.comments), ("", 0, 0));
}
