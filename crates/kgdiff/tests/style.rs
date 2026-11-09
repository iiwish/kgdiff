//! `packages/cli/test/style.test.ts`, ported: colour levels from `--color` and the environment,
//! the painter, and the xterm-256 mapping.

use kgdiff::io::Env;
use kgdiff::style::{ColorMode, is_light_background, resolve_color_level, terminal_depth};
use kgdiff_report::{Painter, Tone, ansi256, strip_ansi};

struct Vars(Vec<(&'static str, &'static str)>);

impl Env for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| (*v).to_owned())
    }
}

fn level(mode: ColorMode, vars: &[(&'static str, &'static str)], tty: bool) -> u8 {
    resolve_color_level(mode, &Vars(vars.to_vec()), tty)
}

#[test]
fn is_off_with_color_never() {
    assert_eq!(level(ColorMode::Never, &[("FORCE_COLOR", "3")], true), 0);
}

#[test]
fn is_on_with_color_always() {
    assert!(level(ColorMode::Always, &[("NO_COLOR", "1")], false) > 0);
    assert_eq!(level(ColorMode::Always, &[], false), 1);
    assert_eq!(
        level(ColorMode::Always, &[("COLORTERM", "truecolor")], false),
        3
    );
}

#[test]
fn follows_the_tty_in_auto_mode() {
    assert_eq!(level(ColorMode::Auto, &[], true), 1);
    assert_eq!(level(ColorMode::Auto, &[], false), 0);
    assert_eq!(level(ColorMode::Auto, &[("TERM", "dumb")], true), 0);
}

#[test]
fn honours_a_non_empty_no_color() {
    assert_eq!(level(ColorMode::Auto, &[("NO_COLOR", "1")], true), 0);
    assert_eq!(level(ColorMode::Auto, &[("NO_COLOR", "")], true), 1);
}

#[test]
fn lets_force_color_win_in_auto_mode() {
    assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "1")], false), 1);
    assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "2")], false), 2);
    assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "3")], false), 3);
    assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "0")], true), 0);
    assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "false")], true), 0);
    assert_eq!(
        level(
            ColorMode::Auto,
            &[("FORCE_COLOR", "1"), ("NO_COLOR", "1")],
            false
        ),
        1
    );
    assert_eq!(
        level(
            ColorMode::Auto,
            &[("FORCE_COLOR", ""), ("COLORTERM", "truecolor")],
            false
        ),
        3
    );
}

#[test]
fn detects_the_color_depth() {
    let depth = |vars: &[(&'static str, &'static str)]| terminal_depth(&Vars(vars.to_vec()));
    assert_eq!(depth(&[("COLORTERM", "truecolor")]), 3);
    assert_eq!(depth(&[("COLORTERM", "24bit")]), 3);
    assert_eq!(depth(&[("TERM", "xterm-256color")]), 2);
    assert_eq!(depth(&[("TERM", "xterm")]), 1);
    assert_eq!(depth(&[("WT_SESSION", "x")]), 3);
}

#[test]
fn detects_light_backgrounds_from_colorfgbg() {
    assert!(is_light_background(&Vars(vec![("COLORFGBG", "0;15")])));
    assert!(!is_light_background(&Vars(vec![("COLORFGBG", "15;0")])));
    assert!(!is_light_background(&Vars(vec![])));
}

#[test]
fn the_painter_is_the_identity_without_color() {
    let p = Painter::new(0, false);
    assert_eq!(p.tone(Tone::Added, "x"), "x");
    assert_eq!(p.bold("x"), "x");
    assert_eq!(p.dim("x"), "x");
}

#[test]
fn the_painter_uses_the_exact_family_colors_in_truecolor() {
    let p = Painter::new(3, false);
    assert_eq!(p.tone(Tone::Added, "+1"), "\x1b[38;2;52;211;153m+1\x1b[39m");
    assert!(p.tone(Tone::Identity, "x").contains("38;2;167;139;250"));
    assert!(
        Painter::new(3, true)
            .tone(Tone::Added, "x")
            .contains("38;2;21;128;61")
    );
}

#[test]
fn the_painter_uses_the_nearest_xterm_256_color_or_the_basic_color() {
    assert_eq!(
        Painter::new(2, false).tone(Tone::Removed, "x"),
        format!("\x1b[38;5;{}mx\x1b[39m", ansi256((0xf8, 0x71, 0x71)))
    );
    assert_eq!(
        Painter::new(1, false).tone(Tone::Structure, "x"),
        "\x1b[36mx\x1b[39m"
    );
}

#[test]
fn round_trips_through_strip_ansi() {
    let p = Painter::new(3, false);
    assert_eq!(strip_ansi(&p.bold(&p.tone(Tone::Content, "~6"))), "~6");
}

#[test]
fn maps_pure_colors_to_the_cube_and_grays_to_the_ramp() {
    assert_eq!(ansi256((255, 0, 0)), 196);
    assert_eq!(ansi256((0, 0, 0)), 16);
    assert_eq!(ansi256((255, 255, 255)), 231);
    assert_eq!(ansi256((128, 128, 128)), 244);
}
