//! `packages/cli/test/args.test.ts`, ported: the command line, its defaults, optional output
//! values, validation and suggestions.

use kgdiff::args::{
    Command, DiffCommandOptions, HelpTopic, edit_distance, parse_command_line, suggest,
};
use kgdiff::errors::Failure;
use kgdiff::style::ColorMode;
use kgdiff_core::Locale;
use kgdiff_core::js::json;
use kgdiff_formats::FormatId;

fn argv(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

fn diff_options(args: &[&str]) -> DiffCommandOptions {
    match parse_command_line(&argv(args)) {
        Ok(Command::Diff(o)) => *o,
        other => panic!("expected diff, got {other:?}"),
    }
}

/// The message and hint of the usage error `args` give.
fn usage_error(args: &[&str]) -> (String, String) {
    match parse_command_line(&argv(args)) {
        Err(Failure::Cli(e)) => (e.message, e.hint.unwrap_or_default()),
        other => panic!("expected a usage error for {args:?}, got {other:?}"),
    }
}

#[test]
fn takes_two_graphs_and_documented_defaults() {
    let o = diff_options(&["a.ttl", "b.ttl"]);
    assert_eq!((o.before.as_str(), o.after.as_str()), ("a.ttl", "b.ttl"));
    assert_eq!((o.before_format, o.after_format), (None, None));
    assert_eq!(json::to_string(&o.diff), "{}");
    assert!(!o.stat && !o.name_status && !o.open && !o.pretty && !o.reproducible && !o.exit_code);
    assert!(o.compute);
    assert!(!o.common.quiet);
    assert_eq!(o.common.color, ColorMode::Auto);
    assert_eq!(o.limit, 50);
    assert!(o.json.is_none() && o.common.locale.is_none());
}

#[test]
fn maps_diff_options_to_diff_options() {
    let o = diff_options(&[
        "a.json",
        "b.json",
        "--match",
        "similarity",
        "--threshold",
        "0.9",
        "--edge-identity",
        "id",
        "--hierarchy",
        "is_a",
        "--hierarchy",
        "part_of",
        "--ignore-attr",
        "updated",
        "--no-merges",
        "--no-splits",
    ]);
    assert_eq!(
        json::to_string(&o.diff),
        r#"{"match":{"strategy":"similarity","threshold":0.9},"edgeIdentity":"id","hierarchyPredicates":["is_a","part_of"],"ignoreAttrs":["updated"],"detectMerges":false,"detectSplits":false}"#
    );
}

#[test]
fn maps_format_and_language_options_to_parse_options() {
    let o = diff_options(&[
        "a",
        "b",
        "-f",
        "turtle",
        "--after-format",
        "ntriples",
        "--lang",
        "zh,en",
    ]);
    assert_eq!(o.before_format, Some(FormatId::Turtle));
    assert_eq!(o.after_format, Some(FormatId::NTriples));
    assert_eq!(o.languages, Some(vec!["zh".to_owned(), "en".to_owned()]));
}

#[test]
fn reads_report_and_behaviour_options() {
    let o = diff_options(&[
        "a",
        "b",
        "-o",
        "r.html",
        "--open",
        "--title",
        "Release 13",
        "--theme",
        "dark",
        "--locale",
        "zh",
        "--mode",
        "replay",
        "--reproducible",
        "--exit-code",
        "-q",
        "--color=never",
        "--limit",
        "0",
    ]);
    assert_eq!(o.html.as_deref(), Some("r.html"));
    assert!(o.open && o.reproducible && o.exit_code && o.common.quiet && o.compute);
    assert_eq!(o.title.as_deref(), Some("Release 13"));
    assert_eq!(o.theme.as_deref(), Some("dark"));
    assert_eq!(o.common.locale, Some(Locale::ZhCn));
    assert_eq!(o.mode.as_deref(), Some("replay"));
    assert_eq!(o.common.color, ColorMode::Never);
    assert_eq!(o.limit, 0);
}

#[test]
fn no_compute_is_refused_for_a_report_without_a_layout() {
    // RFC 0002, D-10: the reports of this kgdiff carry no layout, so the add-on cannot be left out.
    let (message, hint) = usage_error(&["a", "b", "-o", "r.html", "--no-compute"]);
    assert!(
        message.starts_with("--no-compute cannot be honoured"),
        "{message}"
    );
    assert!(message.contains("carry no layout"));
    assert_eq!(hint, "Leave out --no-compute.");
    assert!(
        usage_error(&["a", "b", "--open", "--no-compute"])
            .0
            .starts_with("--no-compute")
    );
    // Without a report there is nothing to honour.
    assert!(!diff_options(&["a", "b", "--no-compute"]).compute);
}

#[test]
fn panels_read_region_state_pairs_as_the_viewer_does() {
    assert!(diff_options(&["a", "b"]).panels.is_none());
    let pairs = |p: Option<Vec<(String, String)>>| {
        p.unwrap_or_default()
            .into_iter()
            .map(|(r, s)| format!("{r}:{s}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_eq!(
        pairs(
            diff_options(&[
                "a",
                "b",
                "--panels",
                "detail:collapsed  minimap:hidden,legend:open"
            ])
            .panels
        ),
        "detail:collapsed minimap:hidden legend:open"
    );
    // Repeatable; a region named again takes the last state.
    assert_eq!(
        pairs(
            diff_options(&[
                "a",
                "b",
                "--panels=list:hidden detail:open",
                "--panels",
                "detail:hidden"
            ])
            .panels
        ),
        "list:hidden detail:hidden"
    );
    assert!(diff_options(&["a", "b", "--panels", " "]).panels.is_none());
}

#[test]
fn panels_explain_what_is_wrong_with_a_suggestion() {
    let (message, hint) = usage_error(&["a", "b", "--panels", "detail"]);
    assert_eq!(message, "Invalid value \"detail\" for --panels.");
    assert!(hint.starts_with("Expected region:state pairs, e.g. --panels \"detail:collapsed"));
    assert!(hint.contains("Regions: list, detail, search, filters, dock, transport"));
    let (message, hint) = usage_error(&["a", "b", "--panels", "detials:hidden"]);
    assert_eq!(message, "Unknown panel region \"detials\" in --panels.");
    assert!(hint.starts_with("Did you mean \"detail\"? Regions: "));
    let (message, hint) = usage_error(&["a", "b", "--panels", "minimap:collapse"]);
    assert_eq!(
        message,
        "Invalid state \"collapse\" for the minimap panel in --panels."
    );
    assert_eq!(
        hint,
        "Did you mean \"collapsed\"? Expected one of: open, collapsed, hidden."
    );
    assert!(
        usage_error(&["a", "b", "--panels", "zoom:open:x"])
            .0
            .contains("--panels")
    );
    assert_eq!(
        usage_error(&["a", "b", "--panels", "sidebar:hidden"]).0,
        "Unknown panel region \"sidebar\" in --panels."
    );
}

#[test]
fn watch_attr_collects_keys_and_is_absent_when_not_given() {
    assert!(diff_options(&["a.obo", "b.obo"]).watch_attrs.is_none());
    assert_eq!(
        diff_options(&[
            "a.ttl",
            "b.ttl",
            "--watch-attr",
            "rdfs:comment",
            "--watch-attr=def"
        ])
        .watch_attrs,
        Some(vec!["rdfs:comment".to_owned(), "def".to_owned()])
    );
    let (message, hint) = usage_error(&["a.ttl", "b.ttl", "--watch-attr", " "]);
    assert_eq!(message, "--watch-attr needs an attribute key.");
    assert!(hint.contains("--watch-attr rdfs:comment"));
}

#[test]
fn accepts_a_dash_for_stdin_on_one_side() {
    assert_eq!(diff_options(&["-", "b.ttl"]).before, "-");
    assert_eq!(diff_options(&["a.ttl", "-"]).after, "-");
    assert_eq!(
        usage_error(&["-", "-"]).0,
        "Only one input can be read from stdin."
    );
}

#[test]
fn treats_arguments_after_a_double_dash_as_files() {
    assert_eq!(
        diff_options(&["--stat", "--", "--weird.json", "b.json"]).before,
        "--weird.json"
    );
}

#[test]
fn optional_outputs_write_to_stdout_without_a_value() {
    assert_eq!(
        diff_options(&["a", "b", "--json"]).json.as_deref(),
        Some("-")
    );
    assert_eq!(
        diff_options(&["a", "b", "--delta"]).delta.as_deref(),
        Some("-")
    );
    assert_eq!(
        diff_options(&["a", "b", "--markdown"]).markdown.as_deref(),
        Some("-")
    );
}

#[test]
fn optional_outputs_take_the_next_argument_as_the_file() {
    let o = diff_options(&["a", "b", "-o", "report.html", "--markdown", "summary.md"]);
    assert_eq!(o.markdown.as_deref(), Some("summary.md"));
    assert_eq!(o.html.as_deref(), Some("report.html"));
    assert_eq!(
        diff_options(&["a", "b", "--json", "out.json"])
            .json
            .as_deref(),
        Some("out.json")
    );
    assert_eq!(
        diff_options(&["a", "b", "--json=out.json"]).json.as_deref(),
        Some("out.json")
    );
}

#[test]
fn optional_outputs_leave_the_graphs_alone_when_they_are_needed() {
    let o = diff_options(&["--json", "a.json", "b.json"]);
    assert_eq!(o.json.as_deref(), Some("-"));
    assert_eq!((o.before.as_str(), o.after.as_str()), ("a.json", "b.json"));
    let p = diff_options(&["--json", "a.json", "b.json", "--markdown", "m.md"]);
    assert_eq!(
        (
            p.before.as_str(),
            p.after.as_str(),
            p.json.as_deref(),
            p.markdown.as_deref()
        ),
        ("a.json", "b.json", Some("-"), Some("m.md"))
    );
}

#[test]
fn optional_outputs_do_not_take_an_option_as_a_value() {
    let o = diff_options(&["a", "b", "--json", "--pretty"]);
    assert_eq!(o.json.as_deref(), Some("-"));
    assert!(o.pretty);
}

#[test]
fn reports_missing_and_extra_graphs() {
    assert_eq!(
        usage_error(&[]).0,
        "Missing <before> and <after> arguments."
    );
    assert_eq!(usage_error(&["a.ttl"]).0, "Missing <after> argument.");
    assert_eq!(
        usage_error(&["a", "b", "c"]).0,
        "Unexpected argument \"c\"."
    );
}

#[test]
fn suggests_the_closest_option_for_typos() {
    let (message, hint) = usage_error(&["a", "b", "--sta"]);
    assert_eq!(message, "Unknown option --sta.");
    assert!(hint.contains("Did you mean --stat?"));
    assert!(
        usage_error(&["a", "b", "--exitcode"])
            .1
            .contains("--exit-code")
    );
    assert!(
        usage_error(&["a", "b", "--name-stauts"])
            .1
            .contains("--name-status")
    );
    assert_eq!(usage_error(&["a", "b", "-x"]).0, "Unknown option -x.");
}

#[test]
fn rejects_invalid_enumerated_values_with_a_suggestion() {
    let (message, hint) = usage_error(&["a", "b", "--match", "simlarity"]);
    assert_eq!(message, "Invalid value \"simlarity\" for --match.");
    assert!(hint.contains("Did you mean \"similarity\"?"));
    assert_eq!(
        usage_error(&["a", "b", "-f", "ttl"]).1,
        "Expected one of: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo."
    );
    assert_eq!(
        usage_error(&["a", "b", "-f", "owl"]).0,
        "Invalid value \"owl\" for --format."
    );
    assert!(
        usage_error(&["a", "b", "--color", "yes"])
            .1
            .contains("auto, always, never")
    );
    assert!(
        usage_error(&["a", "b", "--theme", "blue"])
            .0
            .contains("--theme")
    );
    assert!(
        usage_error(&["a", "b", "--mode", "side"])
            .0
            .contains("--mode")
    );
    assert!(
        usage_error(&["a", "b", "--scope", "some"])
            .1
            .contains("all, changes")
    );
    assert!(
        usage_error(&["a", "b", "--edge-identity", "key"])
            .0
            .contains("--edge-identity")
    );
}

#[test]
fn validates_numbers() {
    assert_eq!(
        usage_error(&["a", "b", "--threshold", "1.5"]).1,
        "Expected a number between 0 and 1."
    );
    assert!(
        usage_error(&["a", "b", "--threshold", "high"])
            .0
            .contains("--threshold")
    );
    assert_eq!(
        usage_error(&["a", "b", "--limit", "2.5"]).1,
        "Expected an integer ≥ 0."
    );
    assert!(usage_error(&["a", "b", "--limit=-1"]).0.contains("--limit"));
}

#[test]
fn requires_values_and_refuses_values_for_flags() {
    assert_eq!(
        usage_error(&["a", "b", "--title"]).0,
        "Option --title needs a value."
    );
    assert!(
        usage_error(&["a", "b", "--title", "--stat"])
            .0
            .contains("needs a value")
    );
    assert_eq!(
        usage_error(&["a", "b", "--stat=yes"]).0,
        "Option --stat does not take a value."
    );
    assert_eq!(
        diff_options(&["a", "b", "--title=-draft-"])
            .title
            .as_deref(),
        Some("-draft-")
    );
}

#[test]
fn rejects_unsupported_locales() {
    assert_eq!(
        usage_error(&["a", "b", "--locale", "fr"]).0,
        "Unsupported locale \"fr\"."
    );
}

#[test]
fn allows_only_one_output_on_stdout() {
    assert_eq!(
        usage_error(&["a", "b", "--json", "--markdown"]).0,
        "--json and --markdown would all write to stdout."
    );
    assert!(
        usage_error(&["a", "b", "--stat", "--delta"])
            .0
            .contains("--delta and --stat")
    );
    assert!(diff_options(&["a", "b", "--stat", "--name-status"]).name_status);
    assert_eq!(
        diff_options(&["a", "b", "--json", "x.json", "--markdown"])
            .markdown
            .as_deref(),
        Some("-")
    );
}

#[test]
fn refuses_an_html_report_on_stdout() {
    assert!(
        usage_error(&["a", "b", "-o", "-"])
            .0
            .contains("must be written to a file")
    );
}

#[test]
fn recognises_help_and_version_anywhere() {
    let kind = |args: &[&str]| match parse_command_line(&argv(args)) {
        Ok(Command::Help { .. }) => "help",
        Ok(Command::Version) => "version",
        Ok(Command::Diff(_)) => "diff",
        Ok(Command::Apply(_)) => "apply",
        Err(_) => "error",
    };
    assert_eq!(kind(&["--help"]), "help");
    assert_eq!(kind(&["a", "b", "-h"]), "help");
    assert_eq!(kind(&["--version"]), "version");
    assert_eq!(kind(&["-v"]), "version");
    assert!(matches!(
        parse_command_line(&argv(&["help", "apply"])),
        Ok(Command::Help {
            topic: HelpTopic::Apply,
            color: ColorMode::Auto
        })
    ));
    assert!(matches!(
        parse_command_line(&argv(&["apply", "--help"])),
        Ok(Command::Help {
            topic: HelpTopic::Apply,
            ..
        })
    ));
    assert!(
        usage_error(&["help", "nope"])
            .0
            .contains("Unknown help topic")
    );
}

#[test]
fn parses_apply() {
    let Ok(Command::Apply(o)) = parse_command_line(&argv(&[
        "apply",
        "g.ttl",
        "d.json",
        "-o",
        "out.json",
        "--no-strict",
    ])) else {
        panic!("expected apply")
    };
    assert_eq!(
        (o.graph.as_str(), o.delta.as_str(), o.output.as_str()),
        ("g.ttl", "d.json", "out.json")
    );
    assert!(!o.strict && !o.pretty && !o.allow_empty && !o.verbose && !o.common.quiet);
    assert_eq!(o.common.color, ColorMode::Auto);
    assert_eq!(o.format, None);
    assert!(o.languages.is_none());
    let Ok(Command::Apply(o)) = parse_command_line(&argv(&["apply", "g", "d"])) else {
        panic!("expected apply")
    };
    assert_eq!(o.output, "-");
    assert_eq!(usage_error(&["apply", "g"]).0, "Missing <delta> argument.");
    assert_eq!(
        usage_error(&["apply", "g", "d", "--stat"]).0,
        "Unknown option --stat."
    );
}

#[test]
fn measures_edit_distance_with_transpositions() {
    assert_eq!(edit_distance("stat", "stat"), 0);
    assert_eq!(edit_distance("sta", "stat"), 1);
    assert_eq!(edit_distance("tsat", "stat"), 1);
    assert_eq!(edit_distance("", "abc"), 3);
}

#[test]
fn suggests_only_close_candidates() {
    assert_eq!(suggest("jsno", &["json", "delta"]), Some("json"));
    assert_eq!(suggest("zzzzzz", &["json", "delta"]), None);
    assert_eq!(suggest("mark", &["markdown", "match"]), Some("markdown"));
}

/// `util.parseArgs` details the messages show (checked against Node 24).
#[test]
fn tokenizes_as_parse_args() {
    // `-o=x` binds `=x`; `-ox` binds `x`; `-qo x` is `-q -o x`.
    assert_eq!(
        diff_options(&["a", "b", "-o=r.html"]).html.as_deref(),
        Some("=r.html")
    );
    assert_eq!(
        diff_options(&["a", "b", "-or.html"]).html.as_deref(),
        Some("r.html")
    );
    let o = diff_options(&["a", "b", "-qo", "r.html"]);
    assert!(o.common.quiet);
    assert_eq!(o.html.as_deref(), Some("r.html"));
    assert_eq!(
        diff_options(&["a", "b", "-qor.html"]).html.as_deref(),
        Some("r.html")
    );
    // A string option takes the next argument whatever it is, then kgdiff refuses a dash.
    let (message, hint) = usage_error(&["a", "b", "-o", "-x.html"]);
    assert_eq!(message, "Option -o needs a value, got \"-x.html\".");
    assert_eq!(
        hint,
        "If that is the value, write --html=-x.html or -o ./-x.html. Run `kgdiff --help` for usage."
    );
    assert_eq!(usage_error(&["a", "b", "-qz"]).0, "Unknown option -z.");
    assert_eq!(usage_error(&["a", "b", "--==x"]).0, "Unknown option --.");
}
