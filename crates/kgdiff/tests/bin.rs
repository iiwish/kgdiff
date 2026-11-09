//! `packages/cli/test/bin.test.ts`, ported: the real binary's exit codes, stdio, stdin piping
//! and error output without a trace.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use common::dataset;

fn kgdiff(args: &[&str], input: Option<&[u8]>) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kgdiff"))
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_default(),
        )
        .env("NO_COLOR", "1")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
        // A run that does not read stdin may exit before it is written.
        let _ = stdin.write_all(input);
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

#[test]
fn prints_the_version() {
    let (code, stdout, _) = kgdiff(&["--version"], None);
    assert_eq!(code, 0);
    assert_eq!(stdout, format!("kgdiff {}\n", kgdiff::VERSION));
}

#[test]
fn exits_1_with_exit_code_when_graphs_differ_0_when_they_do_not() {
    let d = dataset("schema-vocab");
    assert_eq!(
        kgdiff(&[&d.before, &d.after, "--exit-code", "-q"], None).0,
        1
    );
    assert_eq!(
        kgdiff(&[&d.before, &d.before, "--exit-code", "-q"], None).0,
        0
    );
}

#[test]
fn exits_2_with_a_friendly_message_and_no_trace() {
    let (code, stdout, stderr) = kgdiff(&["does-not-exist.ttl", "nope.ttl"], None);
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
    assert!(stderr.starts_with(
        "error: Cannot read <before> \"does-not-exist.ttl\": no such file or directory.\n"
    ));
    assert!(!stderr.contains("    at "));
}

#[test]
fn reads_stdin_and_writes_the_summary_to_stdout() {
    let d = dataset("enterprise-kg");
    let after = std::fs::read(&d.after).unwrap();
    let mut argv = vec![d.before.as_str(), "-"];
    argv.extend(d.flags.iter().map(String::as_str));
    argv.push("--name-status");
    let (code, stdout, stderr) = kgdiff(&argv, Some(&after));
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("G\tLEGAL_REP\t"));
}

#[test]
fn stops_quietly_when_stdout_closes_early() {
    // `kgdiff … | head -1`: the pipe closes before the output is written.
    let d = dataset("enterprise-kg");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kgdiff"))
        .args([d.before.as_str(), d.after.as_str(), "--json", "--pretty"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8(out.stderr).unwrap(), "");
}
