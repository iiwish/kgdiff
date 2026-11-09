//! Locale selection and the text outputs' own strings (`locale.ts`), in English and Simplified
//! Chinese. Hunk titles come from kgdiff-core's `format_hunk`.

use kgdiff_core::Locale;
use kgdiff_core::model::ReplayPhase;
use kgdiff_core::text::to_lowercase;

use crate::model::{ChangeFamily, PossibleMatchSide, is_definition_key};

/// `matchLocale`: any Chinese tag → `zh-CN`, any English or POSIX tag → `en`.
pub fn match_locale(tag: &str) -> Option<Locale> {
    let lowered = to_lowercase(kgdiff_core::js::trim(tag)).into_owned();
    // `.replace(/[.@].*$/, '')`: from the first `.` or `@` whose rest has no line terminator.
    let mut cut = lowered.len();
    for (i, c) in lowered.char_indices() {
        if (c == '.' || c == '@')
            && !lowered[i + 1..].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        {
            cut = i;
            break;
        }
    }
    let t = lowered[..cut].replace('_', "-");
    if t == "zh" || t.starts_with("zh-") || t == "cn" {
        return Some(Locale::ZhCn);
    }
    if t == "en" || t.starts_with("en-") || t == "c" || t == "posix" {
        return Some(Locale::En);
    }
    None
}

/// `resolveLocale`: the flag, else the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG`.
pub fn resolve_locale(flag: Option<Locale>, env: &dyn Fn(&str) -> Option<String>) -> Locale {
    if let Some(flag) = flag {
        return flag;
    }
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(value) = env(name).filter(|v| !v.is_empty()) {
            return match_locale(&value).unwrap_or(Locale::En);
        }
    }
    Locale::En
}

/// `formatInt`: thousands separators without `Intl`.
pub fn format_int(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `plural(n, one, many)`: `1 node`, `1,234 nodes`.
fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", format_int(n), if n == 1 { one } else { many })
}

/// A count before and after (`Count`).
pub type Count = (usize, usize);

/// `formatCount`: `179 → 184`, or `74` when unchanged.
pub fn format_count((before, after): Count) -> String {
    if before == after {
        format_int(after)
    } else {
        format!("{} → {}", format_int(before), format_int(after))
    }
}

/// The table strings of `--stat` and Markdown.
pub struct Table {
    pub nodes: &'static str,
    pub edges: &'static str,
    pub added: &'static str,
    pub removed: &'static str,
    pub modified: &'static str,
    pub unchanged: &'static str,
    pub total: &'static str,
}

/// The strings of one locale (`Messages`).
#[derive(Clone, Copy)]
pub struct Messages {
    locale: Locale,
}

/// `messages(locale)`.
pub fn messages(locale: Locale) -> Messages {
    Messages { locale }
}

fn zh(locale: Locale) -> bool {
    locale == Locale::ZhCn
}

impl Messages {
    fn zh(self) -> bool {
        zh(self.locale)
    }

    /// Group headings, by replay phase.
    pub fn phase(self, phase: ReplayPhase) -> &'static str {
        match (self.zh(), phase) {
            (false, ReplayPhase::Restructure) => "Restructured",
            (false, ReplayPhase::Modify) => "Modified",
            (false, ReplayPhase::Add) => "Added",
            (false, ReplayPhase::Remove) => "Removed",
            (true, ReplayPhase::Restructure) => "结构调整",
            (true, ReplayPhase::Modify) => "修改",
            (true, ReplayPhase::Add) => "新增",
            (true, ReplayPhase::Remove) => "删除",
        }
    }

    /// Counter labels (`+3 added`), by replay phase.
    pub fn counter(self, phase: ReplayPhase) -> &'static str {
        match (self.zh(), phase) {
            (false, ReplayPhase::Add) => "added",
            (false, ReplayPhase::Remove) => "removed",
            (false, ReplayPhase::Modify) => "modified",
            (false, ReplayPhase::Restructure) => "restructured",
            (true, ReplayPhase::Add) => "新增",
            (true, ReplayPhase::Remove) => "删除",
            (true, ReplayPhase::Modify) => "修改",
            (true, ReplayPhase::Restructure) => "结构调整",
        }
    }

    pub fn family(self, family: ChangeFamily) -> &'static str {
        match (self.zh(), family) {
            (false, ChangeFamily::Added) => "added",
            (false, ChangeFamily::Removed) => "removed",
            (false, ChangeFamily::Content) => "content",
            (false, ChangeFamily::Structure) => "structure",
            (false, ChangeFamily::Identity) => "identity",
            (true, ChangeFamily::Added) => "新增",
            (true, ChangeFamily::Removed) => "删除",
            (true, ChangeFamily::Content) => "内容",
            (true, ChangeFamily::Structure) => "结构",
            (true, ChangeFamily::Identity) => "身份",
        }
    }

    /// `179 → 184 nodes · 351 → 353 edges`; one number when a count did not change.
    pub fn totals(self, nodes: Count, edges: Count) -> String {
        if self.zh() {
            return format!(
                "节点 {} · 关系 {}",
                format_count(nodes),
                format_count(edges)
            );
        }
        // The noun agrees with the number next to it (the after count).
        format!(
            "{} {} · {} {}",
            format_count(nodes),
            if nodes.1 == 1 { "node" } else { "nodes" },
            format_count(edges),
            if edges.1 == 1 { "edge" } else { "edges" }
        )
    }

    pub fn changes(self, changes: usize, hunks: usize) -> String {
        if self.zh() {
            format!("{} 组共 {} 处变化", format_int(hunks), format_int(changes))
        } else {
            format!(
                "{} in {}",
                plural(changes, "change", "changes"),
                plural(hunks, "hunk", "hunks")
            )
        }
    }

    pub fn more(self, n: usize) -> String {
        if self.zh() {
            format!("… 另有 {} 组", format_int(n))
        } else {
            format!("… and {} more", format_int(n))
        }
    }

    pub fn more_hint(self) -> &'static str {
        if self.zh() {
            "--limit 0 显示全部"
        } else {
            "--limit 0 lists all"
        }
    }

    pub fn identical(self) -> &'static str {
        if self.zh() {
            "没有差异"
        } else {
            "No differences"
        }
    }

    pub fn identical_detail(self, nodes: usize, edges: usize) -> String {
        if self.zh() {
            format!(
                "两个版本均有 {} 个节点、{} 条关系。",
                format_int(nodes),
                format_int(edges)
            )
        } else {
            format!(
                "Both versions have {} and {}.",
                plural(nodes, "node", "nodes"),
                plural(edges, "edge", "edges")
            )
        }
    }

    pub fn table(self) -> Table {
        if self.zh() {
            Table {
                nodes: "节点",
                edges: "关系",
                added: "新增",
                removed: "删除",
                modified: "修改",
                unchanged: "未变",
                total: "变更前 → 变更后",
            }
        } else {
            Table {
                nodes: "nodes",
                edges: "edges",
                added: "added",
                removed: "removed",
                modified: "modified",
                unchanged: "unchanged",
                total: "before → after",
            }
        }
    }

    pub fn by_type(self) -> &'static str {
        if self.zh() { "按类型" } else { "By type" }
    }

    pub fn untyped(self) -> &'static str {
        if self.zh() {
            "（无类型）"
        } else {
            "(untyped)"
        }
    }

    pub fn more_types(self, n: usize) -> String {
        if self.zh() {
            format!("… 另有 {} 个类型", format_int(n))
        } else {
            format!("… and {}", plural(n, "more type", "more types"))
        }
    }

    /// How the default definition keys are named.
    pub fn watch_definition(self) -> &'static str {
        if self.zh() { "定义" } else { "definition" }
    }

    /// `Review first: definition changed in 10 hunks`.
    pub fn watch_line(self, labels: &[String], hunks: usize) -> String {
        if self.zh() {
            format!(
                "优先审查：{} 组变更修改了{}",
                format_int(hunks),
                labels.join("、")
            )
        } else {
            format!(
                "Review first: {} changed in {}",
                labels.join(", "),
                plural(hunks, "hunk", "hunks")
            )
        }
    }

    /// After ⚑ in a hunk's summary: `definition`.
    pub fn watch_marker(self, labels: &[String]) -> String {
        labels.join(if self.zh() { "、" } else { ", " })
    }

    pub fn possible_heading(self) -> &'static str {
        if self.zh() {
            "可能的匹配"
        } else {
            "Possible matches"
        }
    }

    /// Both sides of a possible match; each side's id is added when they share a name.
    pub fn possible_title(self, before: &PossibleMatchSide, after: &PossibleMatchSide) -> String {
        let same = before.name == after.name;
        let side = |s: &PossibleMatchSide| {
            let quoted = if self.zh() {
                format!("「{}」", s.name)
            } else {
                format!("“{}”", s.name)
            };
            match (same, self.zh()) {
                (false, _) => quoted,
                (true, false) => format!("{quoted} ({})", s.id),
                (true, true) => format!("{quoted}（{}）", s.id),
            }
        };
        let arrow = if self.zh() { "→" } else { " → " };
        format!("{}{arrow}{}", side(before), side(after))
    }

    pub fn possible_below_threshold(self, threshold: &str) -> String {
        if self.zh() {
            format!("低于阈值 {threshold}")
        } else {
            format!("below the {threshold} threshold")
        }
    }

    pub fn possible_ambiguous(self) -> &'static str {
        if self.zh() {
            "与其他候选过于接近"
        } else {
            "too close to another candidate"
        }
    }

    pub fn possible_evidence(self, label: &str, neighbors: &str) -> String {
        if self.zh() {
            format!("名称 {label} · 邻居 {neighbors}")
        } else {
            format!("name {label} · neighbours {neighbors}")
        }
    }

    pub fn possible_hint(self) -> &'static str {
        if self.zh() {
            "这些节点未配对，因此按删除或新增列出。如是同一节点，可补充别名或替换链接，或调低 --threshold。"
        } else {
            "Not paired, so listed as removed or added. To pair one, add a synonym or a replacement link, or lower --threshold."
        }
    }

    pub fn possible_more(self, n: usize) -> String {
        if self.zh() {
            format!("… 另有 {} 对 · --json 列出全部", format_int(n))
        } else {
            format!("… and {} more · --json lists all", format_int(n))
        }
    }

    pub fn markdown_legend(self) -> &'static str {
        if self.zh() {
            "🟩 新增 · 🟥 删除 · 🟨 内容（改名、属性、类型、别名） · 🟦 结构（移动、关系） · 🟪 身份（合并、拆分、换 ID）"
        } else {
            "🟩 added · 🟥 removed · 🟨 content (renames, attributes, types, synonyms) · 🟦 structure (moves, relations) · 🟪 identity (merges, splits)"
        }
    }

    pub fn markdown_more(self, n: usize) -> String {
        if self.zh() {
            format!(
                "……另有 {} 组变更未列出，完整列表请查看 HTML 报告。",
                format_int(n)
            )
        } else {
            format!(
                "…and {}. Open the HTML report for the full list.",
                plural(n, "more hunk", "more hunks")
            )
        }
    }

    pub fn markdown_review_first(self) -> &'static str {
        if self.zh() {
            "优先审查"
        } else {
            "Review first"
        }
    }

    pub fn markdown_review_first_hint(self, labels: &[String]) -> String {
        if self.zh() {
            format!(
                "这些变更修改了受关注的属性（{}）。这类修改在差异里看起来很小，却可能改变已有数据的含义。",
                labels.join("、")
            )
        } else {
            format!(
                "These hunks change a watched attribute ({}). Such an edit can change what existing data means even when the diff looks small.",
                labels.join(", ")
            )
        }
    }

    pub fn markdown_review_first_more(self, n: usize) -> String {
        if self.zh() {
            format!("……另有 {} 组。", format_int(n))
        } else {
            format!("…and {} more.", format_int(n))
        }
    }

    pub fn markdown_possible_hint(self) -> &'static str {
        if self.zh() {
            "kgdiff 没有配对这些节点，因此它们在上方按删除或新增列出。如果某一对其实是同一节点，可补充别名或替换链接，或调低 `--threshold`。"
        } else {
            "kgdiff did not pair these nodes, so they are listed above as removed or added. If a pair is the same thing, add a synonym or a replacement link, or lower `--threshold`."
        }
    }

    pub fn markdown_possible_more(self, n: usize) -> String {
        if self.zh() {
            format!(
                "……另有 {} 对可能的匹配未列出，HTML 报告的节点详情中可以看到全部。",
                format_int(n)
            )
        } else {
            format!(
                "…and {}. The HTML report shows them in each node's details.",
                plural(n, "more possible match", "more possible matches")
            )
        }
    }

    pub fn generated_by(self, generator: &str) -> String {
        if self.zh() {
            format!("由 {generator} 生成")
        } else {
            format!("Generated by {generator}")
        }
    }
}

/// `watchLabels`: display names of watched keys, in order; every default definition key is
/// “definition” (once).
pub fn watch_labels(keys: &[String], m: Messages) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for key in keys {
        let label = if is_definition_key(key) {
            m.watch_definition().to_owned()
        } else {
            key.clone()
        };
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_matches() {
        assert_eq!(format_int(0), "0");
        assert_eq!(format_int(1234567), "1,234,567");
        assert_eq!(format_int(100), "100");
        assert_eq!(match_locale("zh_CN.UTF-8"), Some(Locale::ZhCn));
        assert_eq!(match_locale("C"), Some(Locale::En));
        assert_eq!(match_locale("fr_FR"), None);
        assert_eq!(
            messages(Locale::En).totals((1, 1), (2, 3)),
            "1 node · 2 → 3 edges"
        );
    }
}
