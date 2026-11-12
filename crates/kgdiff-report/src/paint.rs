//! A tiny painter for the meaning families of docs/visual-language.md. Which level a terminal supports is the CLI's to decide (`kgdiff::style`).

/// 0 = no color, 1 = 16 colors, 2 = 256 colors, 3 = truecolor.
pub type ColorLevel = u8;

/// The color tones of the text outputs: the five meaning families plus the UI accent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Tone {
    /// The family of additions.
    Added,
    /// The family of removals.
    Removed,
    /// The family of changes to a node's content.
    Content,
    /// The family of changes to structure.
    Structure,
    /// The family of changes to identity (renames, merges, splits).
    Identity,
    /// The accent of the interface itself.
    Accent,
}

type Rgb = (u8, u8, u8);

struct ToneColors {
    dark: Rgb,
    light: Rgb,
    /// SGR foreground code of the nearest basic color.
    basic: u8,
}

/// docs/visual-language.md: dark `family.*.base`, light `family.*.strong`.
fn colors(tone: Tone) -> ToneColors {
    match tone {
        Tone::Added => ToneColors {
            dark: (0x34, 0xD3, 0x99),
            light: (0x15, 0x80, 0x3D),
            basic: 32,
        },
        Tone::Removed => ToneColors {
            dark: (0xF8, 0x71, 0x71),
            light: (0xB9, 0x1C, 0x1C),
            basic: 31,
        },
        Tone::Content => ToneColors {
            dark: (0xFB, 0xBF, 0x24),
            light: (0xB4, 0x53, 0x09),
            basic: 33,
        },
        Tone::Structure => ToneColors {
            dark: (0x38, 0xBD, 0xF8),
            light: (0x03, 0x69, 0xA1),
            basic: 36,
        },
        Tone::Identity => ToneColors {
            dark: (0xA7, 0x8B, 0xFA),
            light: (0x6D, 0x28, 0xD9),
            basic: 35,
        },
        Tone::Accent => ToneColors {
            dark: (0x7C, 0x9C, 0xFF),
            light: (0x2F, 0x49, 0xB5),
            basic: 34,
        },
    }
}

const CUBE: [i32; 6] = [0, 95, 135, 175, 215, 255];

fn nearest_cube(v: i32) -> usize {
    // The first of equally near levels, keeping the first on a tie.
    let mut best = 0;
    for (i, level) in CUBE.iter().enumerate().skip(1) {
        if (level - v).abs() < (CUBE[best] - v).abs() {
            best = i;
        }
    }
    best
}

/// The nearest xterm-256 palette index (6×6×6 cube or gray ramp) by squared RGB distance.
pub fn ansi256((r, g, b): Rgb) -> u8 {
    let (r, g, b) = (i32::from(r), i32::from(g), i32::from(b));
    let (ri, gi, bi) = (nearest_cube(r), nearest_cube(g), nearest_cube(b));
    let cube = (CUBE[ri], CUBE[gi], CUBE[bi]);
    // `Math.round(((r + g + b) / 3 - 8) / 10)`, clamped to 0..23: half rounds up.
    let mean = f64::from(r + g + b) / 3.0;
    let level = kgdiff_core::js::math::round((mean - 8.0) / 10.0);
    let gray_level: i32 = if level <= 0.0 {
        0
    } else if level >= 23.0 {
        23
    } else {
        (0..=23).find(|&l| f64::from(l) == level).unwrap_or(0)
    };
    let gray = 8 + gray_level * 10;
    let dist = |c: (i32, i32, i32)| (c.0 - r).pow(2) + (c.1 - g).pow(2) + (c.2 - b).pow(2);
    let index = if dist((gray, gray, gray)) < dist(cube) {
        232 + gray_level
    } else {
        16 + 36 * i32::try_from(ri).unwrap_or(0)
            + 6 * i32::try_from(gi).unwrap_or(0)
            + i32::try_from(bi).unwrap_or(0)
    };
    u8::try_from(index).unwrap_or(0)
}

/// Applies colors and text attributes; every method is the identity at level 0.
#[derive(Clone, Debug)]
pub struct Painter {
    /// The color level the painter emits (0 for plain text).
    pub level: ColorLevel,
    open: [String; 6],
}

fn tone_index(tone: Tone) -> usize {
    match tone {
        Tone::Added => 0,
        Tone::Removed => 1,
        Tone::Content => 2,
        Tone::Structure => 3,
        Tone::Identity => 4,
        Tone::Accent => 5,
    }
}

impl Painter {
    /// `createPainter(level, light)`: `light` picks colors that read on light backgrounds.
    pub fn new(level: ColorLevel, light: bool) -> Painter {
        let tones = [
            Tone::Added,
            Tone::Removed,
            Tone::Content,
            Tone::Structure,
            Tone::Identity,
            Tone::Accent,
        ];
        let open = tones.map(|tone| {
            let c = colors(tone);
            let rgb = if light { c.light } else { c.dark };
            match level {
                0 => String::new(),
                3 => format!("\x1b[38;2;{};{};{}m", rgb.0, rgb.1, rgb.2),
                2 => format!("\x1b[38;5;{}m", ansi256(rgb)),
                _ => format!("\x1b[{}m", c.basic),
            }
        });
        Painter { level, open }
    }

    /// The painter of plain text.
    pub fn plain() -> Painter {
        Painter::new(0, false)
    }

    /// Colors `text` in the tone's color; plain at level 0.
    pub fn tone(&self, tone: Tone, text: &str) -> String {
        if self.level == 0 || text.is_empty() {
            return text.to_owned();
        }
        format!("{}{text}\x1b[39m", self.open[tone_index(tone)])
    }

    /// SGR 22 ends both bold and dim; the outputs never nest the two.
    pub fn bold(&self, text: &str) -> String {
        if self.level == 0 || text.is_empty() {
            return text.to_owned();
        }
        format!("\x1b[1m{text}\x1b[22m")
    }

    /// Dims `text`; plain at level 0.
    pub fn dim(&self, text: &str) -> String {
        if self.level == 0 || text.is_empty() {
            return text.to_owned();
        }
        format!("\x1b[2m{text}\x1b[22m")
    }
}

/// `stripAnsi`: SGR escape sequences removed.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if b[i] == 0x1b && b.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
                j += 1;
            }
            if b.get(j) == Some(&b'm') {
                out.push_str(&text[last..i]);
                i = j + 1;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paints_as_typescript() {
        let p = Painter::new(1, false);
        assert_eq!(p.tone(Tone::Added, "x"), "\x1b[32mx\x1b[39m");
        assert_eq!(p.bold(""), "");
        assert_eq!(strip_ansi(&p.dim(&p.tone(Tone::Accent, "a"))), "a");
        // ansi256 of every family color, dark then light, as Node computes it.
        let all: Vec<u8> = [
            Tone::Added,
            Tone::Removed,
            Tone::Content,
            Tone::Structure,
            Tone::Identity,
            Tone::Accent,
        ]
        .iter()
        .flat_map(|&t| [ansi256(colors(t).dark), ansi256(colors(t).light)])
        .collect();
        assert_eq!(all, [78, 29, 203, 124, 214, 130, 75, 25, 141, 56, 111, 25]);
    }
}
