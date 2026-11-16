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
    Command, Completes, CompletionOption, HELP_TOPICS, HelpTopic, SUBCOMMANDS, Shell,
    completion_options, parse_command_line,
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

/// The commands of the scripts and the options each takes: `kgdiff help` takes `--color` only.
fn commands() -> Vec<(&'static str, Vec<CompletionOption>)> {
    let color_only = completion_options(HelpTopic::Completion)
        .into_iter()
        .filter(|o| o.name == "color")
        .collect();
    vec![
        ("diff", completion_options(HelpTopic::Main)),
        ("apply", completion_options(HelpTopic::Apply)),
        ("help", color_only),
        ("completion", completion_options(HelpTopic::Completion)),
    ]
}

/// The one line of `lines` that `found` picks.
fn the_line<'a>(lines: &[&'a str], what: &str, found: impl Fn(&str) -> bool) -> &'a str {
    let hits: Vec<&str> = lines.iter().copied().filter(|l| found(l)).collect();
    assert_eq!(hits.len(), 1, "{what}: {hits:?}");
    hits[0]
}

/// Every option is declared for its own command, with its short form and its values: one
/// `complete` line each.
#[test]
fn the_fish_script_declares_every_option_of_every_command() {
    let script = completion_script(Shell::Fish);
    let lines: Vec<&str> = script.lines().collect();
    for (command, options) in commands() {
        let prefix = format!("complete -c kgdiff -n '__kgdiff_in {command}' -l ");
        let declared = lines.iter().filter(|l| l.starts_with(&prefix)).count();
        assert_eq!(declared, options.len(), "{command}");
        for o in options {
            let what = format!("{command} --{}", o.name);
            let start = format!("{prefix}{}", o.name);
            let line = the_line(&lines, &what, |l| {
                l.strip_prefix(&start)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
            });
            let rest = line[start.len()..]
                .split(" -d '")
                .next()
                .unwrap_or_default();
            let short = o.short.map_or_else(String::new, |s| format!(" -s {s}"));
            let value = match o.value {
                Completes::Nothing | Completes::OptionalFile => String::new(),
                Completes::Choices(choices) => format!(" -x -a '{}'", choices.join(" ")),
                Completes::File => " -r -F".to_owned(),
                Completes::Text => " -x".to_owned(),
            };
            assert_eq!(rest, format!("{short}{value}"), "{what}");
        }
    }
    for (command, words) in [("help", &HELP_TOPICS[..]), ("completion", &Shell::ALL[..])] {
        let line = format!(
            "complete -c kgdiff -n '__kgdiff_in {command}; and __kgdiff_second' -a '{}'",
            words.join(" ")
        );
        assert!(lines.contains(&line.as_str()), "{line}");
        let no_files = format!("complete -c kgdiff -n '__kgdiff_in {command}' -f");
        assert!(lines.contains(&no_files.as_str()), "{no_files}");
    }
    for name in SUBCOMMANDS {
        let start = format!("complete -c kgdiff -n __kgdiff_first -a {name} -d '");
        the_line(&lines, name, |l| l.starts_with(&start));
    }
}

/// Each command's branch lists exactly its options, and every option that takes a value has a
/// branch of its own command that completes that value.
#[test]
fn the_bash_script_lists_every_option_of_every_command() {
    let script = completion_script(Shell::Bash);
    let lines: Vec<&str> = script.lines().map(kgdiff_core::js::trim).collect();
    for (command, options) in commands() {
        let start = format!("{command}) COMPREPLY=($(compgen -W \"");
        let line = the_line(&lines, command, |l| l.starts_with(&start));
        let listed: Vec<&str> = line[start.len()..]
            .split('"')
            .next()
            .unwrap_or_default()
            .split(' ')
            .collect();
        let mut expected = Vec::new();
        for o in &options {
            expected.push(format!("--{}", o.name));
            if let Some(s) = o.short {
                expected.push(format!("-{s}"));
            }
        }
        assert_eq!(listed, expected, "{command}");

        for o in options {
            let label = format!("{command}:--{}", o.name);
            let branch = lines.iter().position(|l| {
                l.strip_suffix(')')
                    .is_some_and(|labels| labels.split('|').any(|x| x == label))
            });
            let takes_value = !matches!(o.value, Completes::Nothing | Completes::OptionalFile);
            assert_eq!(branch.is_some(), takes_value, "{label}");
            let Some(branch) = branch else { continue };
            if let Some(s) = o.short {
                let short = format!("{command}:-{s}");
                assert!(
                    lines[branch]
                        .trim_end_matches(')')
                        .split('|')
                        .any(|x| x == short),
                    "{short}"
                );
            }
            let next = lines[branch + 1];
            match o.value {
                Completes::Choices(choices) => assert_eq!(
                    next,
                    format!(
                        "COMPREPLY=($(compgen -W \"{}\" -- \"$cur\"))",
                        choices.join(" ")
                    ),
                    "{label}"
                ),
                Completes::File => assert_eq!(next, "_kgdiff_files", "{label}"),
                _ => assert_eq!(next, "return ;;", "{label}"),
            }
        }
    }
    let commands_first = format!(
        "[[ $COMP_CWORD -eq 1 ]] && COMPREPLY=($(compgen -W \"{}\" -- \"$cur\"))",
        SUBCOMMANDS.join(" ")
    );
    assert!(lines.contains(&commands_first.as_str()));
}

/// Each command's `_arguments` call has exactly its options, each with its short form, its
/// values, and `*` when it can be given again.
#[test]
fn the_zsh_script_has_the_specs_of_every_command() {
    let script = completion_script(Shell::Zsh);
    for (command, options) in commands() {
        // A subcommand's specs follow its `case` label; `diff`'s are the last `args=(`.
        let from = if command == "diff" {
            script.rfind("\n    args=(\n")
        } else {
            script.find(&format!("\n            {command})\n"))
        };
        let block = &script[from.unwrap_or_else(|| panic!("{command}: no block"))..];
        let block = &block[..block.find("_arguments").unwrap()];
        let specs: Vec<&str> = block
            .lines()
            .map(kgdiff_core::js::trim)
            .filter(|l| l.starts_with('\''))
            .collect();
        let expected: usize = options
            .iter()
            .map(|o| 1 + usize::from(o.short.is_some()))
            .sum();
        assert_eq!(specs.len(), expected, "{command}");
        for o in options {
            let takes_value = o.value != Completes::Nothing;
            let end = match o.value {
                Completes::Nothing => "]'".to_owned(),
                Completes::Choices(choices) => format!("]:{}:({})'", o.name, choices.join(" ")),
                Completes::File => "]:file:_files'".to_owned(),
                Completes::OptionalFile => "]::file:_files'".to_owned(),
                Completes::Text => format!("]:{}: '", o.name),
            };
            let prefix = if o.repeatable {
                "*".to_owned()
            } else {
                o.short
                    .map_or_else(String::new, |s| format!("(-{s} --{})", o.name))
            };
            let mut flags = vec![format!(
                "--{}{}[",
                o.name,
                if takes_value { "=" } else { "" }
            )];
            if let Some(s) = o.short {
                flags.push(format!("-{s}{}[", if takes_value { "+" } else { "" }));
            }
            for flag in flags {
                let start = format!("'{prefix}{flag}");
                let spec = the_line(&specs, &format!("{command} {flag}"), |l| {
                    l.starts_with(&start)
                });
                assert!(spec.ends_with(&end), "{command}: {spec}");
            }
        }
    }
    for words in [&HELP_TOPICS[..], &Shell::ALL[..]] {
        assert!(script.contains(&format!(":({})'\n", words.join(" "))));
    }
    for name in SUBCOMMANDS {
        assert!(script.contains(&format!("{name}\\:\"")), "{name}");
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
    assert!(page.stdout.contains("eval \"$(kgdiff completion bash)\""));
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

// ─── The scripts in their shells ─────────────────────────────────────────────

/// The scripts run by the shells they are for, where those are installed: `bash` and `zsh`
/// check the syntax, and `bash` and `fish` complete command lines. A shell that is missing is
/// skipped with a note, and fails the test when `KGDIFF_REQUIRE_SHELLS` is set, as CI sets it
/// where it installs all three.
#[cfg(unix)]
mod in_the_shells {
    use std::path::PathBuf;
    use std::process::Command as Process;

    use kgdiff::args::Shell;
    use kgdiff::completion::completion_script;

    fn installed(shell: &str) -> bool {
        let found = Process::new(shell)
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !found {
            assert!(
                std::env::var_os("KGDIFF_REQUIRE_SHELLS").is_none(),
                "{shell} is not installed"
            );
            eprintln!("skipped: {shell} is not installed");
        }
        found
    }

    /// A directory of this test's own, holding the script and one graph file.
    fn workspace(test: &str, shell: Shell, name: &str) -> (PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("kgdiff-completion-{}-{test}", std::process::id()));
        let files = dir.join("files");
        std::fs::create_dir_all(&files).unwrap();
        std::fs::write(files.join("graph.json"), "{}").unwrap();
        let script = dir.join(format!("completion.{name}"));
        std::fs::write(&script, completion_script(shell)).unwrap();
        (script, files)
    }

    fn sorted(text: &str) -> Vec<String> {
        let mut words: Vec<String> = text
            .lines()
            // fish prints `word<TAB>description`.
            .filter_map(|l| l.split('\t').next())
            .filter(|w| !w.is_empty())
            .map(str::to_owned)
            .collect();
        words.sort();
        words
    }

    fn expect(words: &[&str]) -> Vec<String> {
        let mut words: Vec<String> = words.iter().map(|w| (*w).to_owned()).collect();
        words.sort();
        words
    }

    #[test]
    fn bash_and_zsh_and_fish_parse_their_scripts() {
        for (shell, name, flag) in [
            (Shell::Bash, "bash", "-n"),
            (Shell::Zsh, "zsh", "-n"),
            (Shell::Fish, "fish", "--no-execute"),
        ] {
            if !installed(name) {
                continue;
            }
            let (script, _) = workspace("syntax", shell, name);
            let out = Process::new(name).arg(flag).arg(&script).output().unwrap();
            assert!(
                out.status.success() && out.stderr.is_empty(),
                "{name}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// `_kgdiff` with the words bash would give it, under `set -u`.
    #[test]
    fn bash_completes() {
        if !installed("bash") {
            return;
        }
        let (script, files) = workspace("bash", Shell::Bash, "bash");
        let complete = |words: &[&str]| {
            let out = Process::new("bash")
                .current_dir(&files)
                .arg("-c")
                .arg(
                    r#"set -u; source "$1"; shift; COMP_WORDS=(kgdiff "$@"); COMP_CWORD=$#; _kgdiff
                       printf '%s\n' ${COMPREPLY[@]+"${COMPREPLY[@]}"}"#,
                )
                .arg("_")
                .arg(&script)
                .args(words)
                .output()
                .unwrap();
            assert!(
                out.status.success() && out.stderr.is_empty(),
                "{words:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            sorted(&String::from_utf8_lossy(&out.stdout))
        };
        assert_eq!(complete(&["--ma"]), expect(&["--markdown", "--match"]));
        assert_eq!(
            complete(&["--match", ""]),
            expect(&["auto", "id", "similarity"])
        );
        // --option=value: three words in bash 4 and later, one in bash 3.2.
        assert_eq!(complete(&["--color", "=", "al"]), expect(&["always"]));
        assert_eq!(complete(&["--color=al"]), expect(&["always"]));
        assert_eq!(complete(&["--html=gr"]), expect(&["graph.json"]));
        assert_eq!(complete(&["-o", "gr"]), expect(&["graph.json"]));
        assert_eq!(complete(&["--title", ""]), expect(&[]));
        assert_eq!(complete(&["ap"]), expect(&["apply"]));
        assert_eq!(complete(&["g"]), expect(&["graph.json"]));
        assert_eq!(complete(&["graph.json", "ap"]), expect(&[]));
        assert_eq!(complete(&["apply", "--no"]), expect(&["--no-strict"]));
        assert_eq!(complete(&["help", ""]), expect(&["apply", "completion"]));
        assert_eq!(complete(&["help", "apply", ""]), expect(&[]));
        assert_eq!(complete(&["completion", "z"]), expect(&["zsh"]));
    }

    /// What fish offers for a command line (`complete -C`), with the script loaded.
    #[test]
    fn fish_completes() {
        if !installed("fish") {
            return;
        }
        let (script, files) = workspace("fish", Shell::Fish, "fish");
        let complete = |line: &str| {
            let out = Process::new("fish")
                .current_dir(&files)
                .arg("--no-config")
                .arg("-c")
                .arg("source $argv[1]; complete -C $argv[2]")
                .arg(&script)
                .arg(line)
                .output()
                .unwrap();
            assert!(
                out.status.success() && out.stderr.is_empty(),
                "{line}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            sorted(&String::from_utf8_lossy(&out.stdout))
        };
        assert_eq!(complete("kgdiff --ma"), expect(&["--markdown", "--match"]));
        assert_eq!(
            complete("kgdiff --match "),
            expect(&["auto", "id", "similarity"])
        );
        assert_eq!(
            complete("kgdiff --theme "),
            expect(&["auto", "dark", "light"])
        );
        assert_eq!(complete("kgdiff --title "), expect(&[]));
        assert_eq!(complete("kgdiff -o gr"), expect(&["graph.json"]));
        assert_eq!(complete("kgdiff --json gr"), expect(&["graph.json"]));
        assert_eq!(complete("kgdiff ap"), expect(&["apply"]));
        assert_eq!(complete("kgdiff gr"), expect(&["graph.json"]));
        assert_eq!(complete("kgdiff graph.json ap"), expect(&[]));
        assert_eq!(complete("kgdiff apply --no"), expect(&["--no-strict"]));
        assert_eq!(complete("kgdiff apply gr"), expect(&["graph.json"]));
        assert_eq!(complete("kgdiff help "), expect(&["apply", "completion"]));
        assert_eq!(complete("kgdiff help apply "), expect(&[]));
        assert_eq!(
            complete("kgdiff completion "),
            expect(&["bash", "fish", "zsh"])
        );
        assert_eq!(complete("kgdiff completion fish "), expect(&[]));
    }
}
