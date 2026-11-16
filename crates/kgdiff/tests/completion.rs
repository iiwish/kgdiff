//! `kgdiff completion <shell>`: the three scripts, pinned as snapshots and checked against the
//! option tables they are generated from, and the command itself.
//!
//! After an intended change of the scripts, write the snapshots again and review their diff:
//!
//! ```sh
//! KGDIFF_UPDATE_SNAPSHOTS=1 cargo test -p kgdiff --test completion
//! ```

mod common;

use common::run;
use kgdiff::args::{
    Command, Completes, HELP_TOPICS, HelpTopic, SUBCOMMANDS, Shell, completion_options,
    parse_command_line,
};
use kgdiff::completion::completion_script;
use kgdiff::help::option_description;

const SHELLS: [(Shell, &str); 3] = [
    (Shell::Bash, "bash"),
    (Shell::Zsh, "zsh"),
    (Shell::Fish, "fish"),
];

fn argv(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

/// The words of a script: what is left when quotes, brackets and separators are cut away.
fn words(script: &str) -> Vec<&str> {
    script
        .split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
        .filter(|w| !w.is_empty())
        .collect()
}

#[test]
fn matches_the_snapshots() {
    let mut failures = Vec::new();
    for (shell, name) in SHELLS {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("tests/snapshots/completion.{name}"));
        let script = completion_script(shell);
        if std::env::var_os("KGDIFF_UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(&path, &script).unwrap();
        } else if std::fs::read_to_string(&path).unwrap() != script {
            failures.push(name);
        }
    }
    assert!(
        failures.is_empty(),
        "differ from the snapshots: {failures:?}"
    );
}

#[test]
fn every_script_has_every_option_value_and_command() {
    for (shell, name) in SHELLS {
        let script = completion_script(shell);
        let words = words(&script);
        for topic in [HelpTopic::Main, HelpTopic::Apply, HelpTopic::Completion] {
            for o in completion_options(topic) {
                // fish names an option without its dashes (`-l format -s f`).
                let (long, short) = if shell == Shell::Fish {
                    (o.name.to_owned(), o.short.map(|s| s.to_string()))
                } else {
                    (format!("--{}", o.name), o.short.map(|s| format!("-{s}")))
                };
                assert!(words.contains(&long.as_str()), "{name}: {long}");
                if let Some(short) = short {
                    assert!(words.contains(&short.as_str()), "{name}: {short}");
                }
                if let Completes::Choices(choices) = o.value {
                    for choice in choices {
                        assert!(words.contains(choice), "{name}: --{} {choice}", o.name);
                    }
                }
            }
        }
        for word in SUBCOMMANDS
            .iter()
            .chain(HELP_TOPICS.iter())
            .chain(Shell::ALL.iter())
        {
            assert!(words.contains(word), "{name}: {word}");
        }
    }
}

#[test]
fn every_option_has_a_description_from_the_help() {
    for topic in [HelpTopic::Main, HelpTopic::Apply, HelpTopic::Completion] {
        for o in completion_options(topic) {
            assert!(
                option_description(topic, o.name).is_some_and(|d| !d.is_empty()),
                "{topic:?}: --{}",
                o.name
            );
        }
    }
}

/// The values the scripts offer are the ones the parser accepts, and no others: an option
/// whose values become a fixed set must be listed in `choices_of`.
#[test]
fn offers_the_values_the_parser_accepts() {
    let files = |topic| {
        if topic == HelpTopic::Apply {
            vec!["apply", "g.json", "d.json"]
        } else {
            vec!["a.json", "b.json"]
        }
    };
    let mut free_text = Vec::new();
    for topic in [HelpTopic::Main, HelpTopic::Apply] {
        for o in completion_options(topic) {
            match o.value {
                Completes::Choices(choices) => {
                    let option = format!("--{}", o.name);
                    for choice in choices {
                        let mut args = files(topic);
                        args.extend([option.as_str(), choice]);
                        assert!(
                            matches!(
                                parse_command_line(&argv(&args)),
                                Ok(Command::Diff(_) | Command::Apply(_))
                            ),
                            "{args:?}"
                        );
                    }
                    let mut args = files(topic);
                    args.extend([option.as_str(), "no-such-value"]);
                    assert!(parse_command_line(&argv(&args)).is_err(), "{args:?}");
                }
                Completes::Text if topic == HelpTopic::Main => free_text.push(o.name),
                _ => {}
            }
        }
    }
    assert_eq!(
        free_text,
        [
            "lang",
            "threshold",
            "hierarchy",
            "ignore-attr",
            "title",
            "panels",
            "limit",
            "watch-attr"
        ]
    );
}

#[test]
fn files_are_completed_where_a_file_is_written() {
    let value = |topic, name: &str| {
        completion_options(topic)
            .into_iter()
            .find(|o| o.name == name)
            .map(|o| o.value)
    };
    assert_eq!(value(HelpTopic::Main, "html"), Some(Completes::File));
    assert_eq!(value(HelpTopic::Apply, "output"), Some(Completes::File));
    for name in ["json", "delta", "markdown"] {
        assert_eq!(value(HelpTopic::Main, name), Some(Completes::OptionalFile));
    }
    assert_eq!(value(HelpTopic::Main, "stat"), Some(Completes::Nothing));
}

#[test]
fn prints_the_script_of_each_shell() {
    for (shell, name) in SHELLS {
        let r = run(&["completion", name], &[]);
        assert_eq!((r.code, r.stderr.as_str()), (0, ""), "{name}");
        assert_eq!(r.stdout, completion_script(shell));
        assert!(r.stdout.ends_with('\n') && !r.stdout.contains('\r'));
    }
}

#[test]
fn says_which_shells_it_knows() {
    let r = run(&["completion", "zhs"], &[]);
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: Unknown shell \"zhs\".\nhint: Did you mean \"zsh\"? Expected one of: bash, zsh, fish.\n"
    );
    let r = run(&["completion"], &[]);
    assert_eq!(r.code, 2);
    assert_eq!(
        r.stderr,
        "error: Missing <shell> argument.\nhint: Usage: kgdiff completion <bash|zsh|fish>.\n"
    );
    let r = run(&["completion", "bash", "zsh"], &[]);
    assert_eq!(r.code, 2);
    assert!(
        r.stderr
            .starts_with("error: Unexpected argument \"zsh\".\n")
    );
    assert_eq!(run(&["completion", "--nope"], &[]).code, 2);
}

#[test]
fn has_a_help_page() {
    let page = run(&["completion", "--help"], &[]);
    assert_eq!(page.code, 0);
    assert!(page.stdout.contains("kgdiff completion <bash|zsh|fish>"));
    assert!(page.stdout.contains("source <(kgdiff completion bash)"));
    assert_eq!(run(&["help", "completion"], &[]).stdout, page.stdout);
    assert_eq!(run(&["completion", "-h"], &[]).stdout, page.stdout);
    for line in page.stdout.split('\n') {
        assert!(line.chars().count() <= 80, "{line}");
    }
    assert!(
        run(&["--help"], &[])
            .stdout
            .contains("\n  kgdiff completion <bash|zsh|fish>\n")
    );
}

/// A file named like a command is still a file when it is not the first argument, or is
/// written as a path.
#[test]
fn a_file_named_completion_can_still_be_compared() {
    assert!(matches!(
        parse_command_line(&argv(&["./completion", "zsh"])),
        Ok(Command::Diff(_))
    ));
    assert!(matches!(
        parse_command_line(&argv(&["a.json", "completion"])),
        Ok(Command::Diff(_))
    ));
}
