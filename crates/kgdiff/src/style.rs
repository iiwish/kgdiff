//! Colour support detection (`style.ts`): `--color`, whether the stream is a terminal,
//! `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `TERM`, and `COLORFGBG` for a light background.
//! The painting itself is `kgdiff_report::Painter`.

use kgdiff_core::js;
use kgdiff_core::text::to_lowercase;
use kgdiff_report::{ColorLevel, Painter};

use crate::io::Env;

/// `--color`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ColorMode {
    #[default]
    Auto,
    Always,
    Never,
}

impl ColorMode {
    pub const ALL: [&'static str; 3] = ["auto", "always", "never"];

    pub fn from_id(id: &str) -> Option<ColorMode> {
        match id {
            "auto" => Some(ColorMode::Auto),
            "always" => Some(ColorMode::Always),
            "never" => Some(ColorMode::Never),
            _ => None,
        }
    }
}

/// `FORCE_COLOR`: `0` / `false` off, `1`–`3` exactly that level, anything else on at the
/// terminal's depth (`None` inside `Some`); unset is `None`.
fn force_color_level(value: Option<&str>) -> Option<Option<ColorLevel>> {
    let value = value?;
    let v = to_lowercase(js::trim(value));
    Some(match v.as_ref() {
        "false" | "0" => Some(0),
        "1" => Some(1),
        "2" => Some(2),
        "3" => Some(3),
        _ => None,
    })
}

/// Whether `TERM` ends in `-256color`, `-256colour` or `-256`.
fn term_256(term: &str) -> bool {
    ["-256", "-256color", "-256colour"]
        .iter()
        .any(|suffix| term.ends_with(suffix))
}

/// The colour depth the terminal supports, assuming colour is wanted at all (`terminalDepth`).
pub fn terminal_depth(env: &dyn Env) -> ColorLevel {
    let colorterm = to_lowercase(&env.var("COLORTERM").unwrap_or_default()).into_owned();
    if colorterm == "truecolor" || colorterm == "24bit" {
        return 3;
    }
    let term = to_lowercase(&env.var("TERM").unwrap_or_default()).into_owned();
    if env.var("WT_SESSION").is_some_and(|v| !v.is_empty())
        || term == "xterm-kitty"
        || term == "xterm-ghostty"
        || term == "wezterm"
    {
        return 3;
    }
    if env.var("GITHUB_ACTIONS").as_deref() == Some("true") {
        return 3;
    }
    if term_256(&term) || env.var("TERM_PROGRAM").as_deref() == Some("Apple_Terminal") {
        return 2;
    }
    1
}

/// `resolveColorLevel`: `never` is off; `always` is `FORCE_COLOR`'s level (1–3) or the terminal
/// depth, even with `NO_COLOR`; `auto` lets `FORCE_COLOR` decide, then a non-empty `NO_COLOR`
/// turns colour off, then colour only on a terminal whose `TERM` is not `dumb`.
pub fn resolve_color_level(mode: ColorMode, env: &dyn Env, is_tty: bool) -> ColorLevel {
    if mode == ColorMode::Never {
        return 0;
    }
    let forced = force_color_level(env.var("FORCE_COLOR").as_deref());
    let depth = || terminal_depth(env).max(1);
    if mode == ColorMode::Always {
        return match forced {
            Some(Some(level)) if level > 0 => level,
            _ => depth(),
        };
    }
    if let Some(forced) = forced {
        return forced.unwrap_or_else(depth);
    }
    if env.var("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return 0;
    }
    if !is_tty || env.var("TERM").as_deref() == Some("dumb") {
        return 0;
    }
    terminal_depth(env)
}

/// True when `COLORFGBG` (rxvt, Konsole, iTerm2…) reports a light background (7 or 15).
pub fn is_light_background(env: &dyn Env) -> bool {
    let value = env.var("COLORFGBG").unwrap_or_default();
    let last = value.rsplit(';').next().unwrap_or("");
    let bg = js::number_from_str(last);
    bg == 7.0 || bg == 15.0
}

/// A painter for a stream (`createPainter(resolveColorLevel(…), isLightBackground(env))`).
pub fn painter(mode: ColorMode, env: &dyn Env, is_tty: bool) -> Painter {
    Painter::new(
        resolve_color_level(mode, env, is_tty),
        is_light_background(env),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kgdiff_core::js::IndexMap;

    struct Vars(IndexMap<&'static str, &'static str>);
    impl Env for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).map(|v| (*v).to_owned())
        }
    }
    fn env(pairs: &[(&'static str, &'static str)]) -> Vars {
        Vars(pairs.iter().copied().collect())
    }

    #[test]
    fn resolves_levels_as_typescript() {
        let level = |mode, pairs: &[(&'static str, &'static str)], tty| {
            resolve_color_level(mode, &env(pairs), tty)
        };
        assert_eq!(level(ColorMode::Auto, &[], false), 0);
        assert_eq!(level(ColorMode::Auto, &[], true), 1);
        assert_eq!(
            level(ColorMode::Auto, &[("TERM", "xterm-256color")], true),
            2
        );
        assert_eq!(
            level(ColorMode::Auto, &[("COLORTERM", "truecolor")], true),
            3
        );
        assert_eq!(level(ColorMode::Auto, &[("NO_COLOR", "1")], true), 0);
        assert_eq!(level(ColorMode::Auto, &[("NO_COLOR", "")], true), 1);
        assert_eq!(level(ColorMode::Auto, &[("TERM", "dumb")], true), 0);
        assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "2")], false), 2);
        assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "0")], true), 0);
        assert_eq!(level(ColorMode::Auto, &[("FORCE_COLOR", "")], false), 1);
        assert_eq!(level(ColorMode::Always, &[("NO_COLOR", "1")], false), 1);
        assert_eq!(level(ColorMode::Always, &[("FORCE_COLOR", "0")], false), 1);
        assert_eq!(level(ColorMode::Never, &[("FORCE_COLOR", "3")], true), 0);
        assert!(is_light_background(&env(&[("COLORFGBG", "0;15")])));
        assert!(!is_light_background(&env(&[("COLORFGBG", "15;0")])));
    }
}
