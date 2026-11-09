//! The presentation model every text output shares (`model.ts`): hunk families, glyphs,
//! name-status letters, phase grouping, the counts behind the counters and the diffstat bar, the
//! watched attributes flagged for review first, and the possible matches.

use std::cmp::Ordering;

use kgdiff_core::js::{self, IndexSet};
use kgdiff_core::model::{ChangeStatus, Hunk, HunkKind, NodeFacet, ReplayPhase, SuggestionReason};
use kgdiff_core::util::count_to_f64;
use kgdiff_core::{DiffResult, KgdiffError};

use crate::paint::Tone;

/// The five meaning families of docs/visual-language.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeFamily {
    Added,
    Removed,
    Content,
    Structure,
    Identity,
}

impl ChangeFamily {
    pub fn tone(self) -> Tone {
        match self {
            ChangeFamily::Added => Tone::Added,
            ChangeFamily::Removed => Tone::Removed,
            ChangeFamily::Content => Tone::Content,
            ChangeFamily::Structure => Tone::Structure,
            ChangeFamily::Identity => Tone::Identity,
        }
    }
}

/// The family a hunk is shown with (`hunkFamily`): its kind's, except that a `modify` hunk made
/// only of hierarchy moves (phase `restructure`) is `structure`.
pub fn hunk_family(hunk: &Hunk) -> ChangeFamily {
    match hunk.kind {
        HunkKind::Add => ChangeFamily::Added,
        HunkKind::Remove => ChangeFamily::Removed,
        HunkKind::Merge | HunkKind::Split => ChangeFamily::Identity,
        HunkKind::Relations => ChangeFamily::Structure,
        HunkKind::Modify if hunk.phase == ReplayPhase::Restructure => ChangeFamily::Structure,
        HunkKind::Modify => ChangeFamily::Content,
    }
}

/// The glyph of a hunk: `+ − ~ ⇄ ⊕ ⑂` (`hunkGlyph`).
pub fn hunk_glyph(hunk: &Hunk) -> &'static str {
    match hunk.kind {
        HunkKind::Add => "+",
        HunkKind::Remove => "−",
        HunkKind::Merge => "⊕",
        HunkKind::Split => "⑂",
        HunkKind::Relations => "⇄",
        HunkKind::Modify if hunk.phase == ReplayPhase::Restructure => "⇄",
        HunkKind::Modify => "~",
    }
}

/// The `--name-status` letter (`nameStatus`).
pub fn name_status(hunk: &Hunk, diff: &DiffResult) -> &'static str {
    match hunk.kind {
        HunkKind::Add => "A",
        HunkKind::Remove => "D",
        HunkKind::Merge => "G",
        HunkKind::Split => "S",
        HunkKind::Relations => "E",
        HunkKind::Modify => {
            let facets = diff.node(&hunk.anchor).map_or(&[][..], |n| &n.facets[..]);
            if facets.iter().any(|f| matches!(f, NodeFacet::Rename { .. })) {
                "R"
            } else if facets.iter().any(|f| matches!(f, NodeFacet::Move { .. })) {
                "V"
            } else {
                "M"
            }
        }
    }
}

/// The order of the phase groups in hunk lists (`LIST_PHASES`).
pub const LIST_PHASES: [ReplayPhase; 4] = [
    ReplayPhase::Remove,
    ReplayPhase::Restructure,
    ReplayPhase::Modify,
    ReplayPhase::Add,
];

/// The order of the counters and the diffstat bar segments (`COUNTER_PHASES`).
pub const COUNTER_PHASES: [ReplayPhase; 4] = [
    ReplayPhase::Add,
    ReplayPhase::Remove,
    ReplayPhase::Modify,
    ReplayPhase::Restructure,
];

/// The counter glyph of a phase (`PHASE_GLYPH`).
pub fn phase_glyph(phase: ReplayPhase) -> &'static str {
    match phase {
        ReplayPhase::Add => "+",
        ReplayPhase::Remove => "−",
        ReplayPhase::Modify => "~",
        ReplayPhase::Restructure => "⇄",
    }
}

/// The family of a phase (`PHASE_FAMILY`).
pub fn phase_family(phase: ReplayPhase) -> ChangeFamily {
    match phase {
        ReplayPhase::Add => ChangeFamily::Added,
        ReplayPhase::Remove => ChangeFamily::Removed,
        ReplayPhase::Modify => ChangeFamily::Content,
        ReplayPhase::Restructure => ChangeFamily::Structure,
    }
}

/// Hunks and changed elements of one phase.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhaseCount {
    pub hunks: usize,
    pub changes: usize,
}

/// Per-phase hunk and change counts (`Overview`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Overview {
    /// In `LIST_PHASES` order: remove, restructure, modify, add.
    phases: [PhaseCount; 4],
    pub changes: usize,
    pub hunks: usize,
}

fn phase_index(phase: ReplayPhase) -> usize {
    match phase {
        ReplayPhase::Remove => 0,
        ReplayPhase::Restructure => 1,
        ReplayPhase::Modify => 2,
        ReplayPhase::Add => 3,
    }
}

impl Overview {
    pub fn phase(&self, phase: ReplayPhase) -> PhaseCount {
        self.phases[phase_index(phase)]
    }
}

/// `overview`.
pub fn overview(diff: &DiffResult) -> Overview {
    let mut out = Overview {
        hunks: diff.hunks.len(),
        ..Overview::default()
    };
    for h in &diff.hunks {
        let n = h.nodes.len() + h.edges.len();
        let count = &mut out.phases[phase_index(h.phase)];
        count.hunks += 1;
        count.changes += n;
        out.changes += n;
    }
    out
}

/// Hunks in list order, grouped by `LIST_PHASES`, each group in review order (`groupByPhase`).
pub fn group_by_phase(hunks: &[Hunk]) -> Vec<(ReplayPhase, Vec<&Hunk>)> {
    LIST_PHASES
        .iter()
        .map(|&phase| {
            let mut list: Vec<&Hunk> = hunks.iter().filter(|h| h.phase == phase).collect();
            list.sort_by_key(|h| h.order);
            (phase, list)
        })
        .filter(|(_, list)| !list.is_empty())
        .collect()
}

/// `apportion`: `total` cells split among `weights` proportionally (largest remainder); every
/// positive weight gets at least one cell when `total` allows.
pub fn apportion(weights: &[usize], total: usize) -> Vec<usize> {
    let sum: usize = weights.iter().sum();
    if sum == 0 || total == 0 {
        return vec![0; weights.len()];
    }
    let (sum_f, total_f) = (count_to_f64(sum), count_to_f64(total));
    let exact: Vec<f64> = weights
        .iter()
        .map(|&w| (count_to_f64(w) / sum_f) * total_f)
        .collect();
    let mut cells: Vec<usize> = exact
        .iter()
        .zip(weights)
        .map(|(&x, &w)| {
            if w > 0 {
                kgdiff_core::util::f64_to_count(x.floor()).max(1)
            } else {
                0
            }
        })
        .collect();
    let mut used: usize = cells.iter().sum();
    let mut by_remainder: Vec<(usize, f64)> = exact
        .iter()
        .enumerate()
        .map(|(i, &x)| (i, x - x.floor()))
        .collect();
    by_remainder.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut k = 0;
    while used < total && k < by_remainder.len() * 2 {
        let i = by_remainder[k % by_remainder.len()].0;
        if weights[i] > 0 {
            cells[i] += 1;
            used += 1;
        }
        k += 1;
    }
    // Minimum cells may overshoot a tiny total: take back from the largest segments.
    while used > total {
        let mut largest = 0;
        for i in 1..cells.len() {
            if cells[i] > cells[largest] {
                largest = i;
            }
        }
        cells[largest] -= 1;
        used -= 1;
    }
    cells
}

/// Attributes watched by default: definitions (`DEFAULT_WATCH_ATTRS`).
pub const DEFAULT_WATCH_ATTRS: [&str; 4] = ["def", "definition", "IAO:0000115", "skos:definition"];

/// Whether `key` is one of the default definition keys, shown as “definition”.
pub fn is_definition_key(key: &str) -> bool {
    DEFAULT_WATCH_ATTRS.contains(&key)
}

/// The watched attributes each hunk changes, by hunk id, in `watch` order (`watchedChanges`).
pub fn watched_changes(diff: &DiffResult, watch: &[String]) -> Vec<(String, Vec<String>)> {
    let watched: IndexSet<&str> = watch.iter().map(String::as_str).collect();
    let mut by_hunk = Vec::new();
    if watched.is_empty() {
        return by_hunk;
    }
    for hunk in &diff.hunks {
        let mut keys: IndexSet<&str> = IndexSet::default();
        for id in &hunk.nodes {
            for facet in diff.node(id).map_or(&[][..], |n| &n.facets[..]) {
                if let NodeFacet::Attrs { changes } = facet {
                    for change in changes {
                        if watched.contains(change.key.as_str()) {
                            keys.insert(change.key.as_str());
                        }
                    }
                }
            }
        }
        if !keys.is_empty() {
            let list = watched
                .iter()
                .filter(|k| keys.contains(*k))
                .map(|k| (*k).to_owned())
                .collect();
            by_hunk.push((hunk.id.to_string(), list));
        }
    }
    by_hunk
}

/// The watched keys of one hunk.
pub fn watched_of<'a>(watched: &'a [(String, Vec<String>)], hunk: &str) -> Option<&'a [String]> {
    watched
        .iter()
        .find(|(id, _)| id == hunk)
        .map(|(_, keys)| keys.as_slice())
}

/// One side of a possible match.
#[derive(Clone, Debug, PartialEq)]
pub struct PossibleMatchSide {
    pub id: String,
    pub name: String,
}

/// A pairing kgdiff considered but did not apply, ready to list (`PossibleMatch`).
#[derive(Clone, Debug, PartialEq)]
pub struct PossibleMatch {
    pub before: PossibleMatchSide,
    pub after: PossibleMatchSide,
    pub score: f64,
    pub reason: SuggestionReason,
    pub label: f64,
    pub neighbors: f64,
}

/// The longest name shown for either side.
const MAX_POSSIBLE_NAME: usize = 40;

fn short_name(label: &str) -> String {
    let chars: Vec<char> = label.chars().collect();
    if chars.len() > MAX_POSSIBLE_NAME {
        let mut out: String = chars[..MAX_POSSIBLE_NAME - 1].iter().collect();
        out.push('…');
        out
    } else {
        label.to_owned()
    }
}

/// The suggestions a reviewer of the text outputs needs (`possibleMatches`): where the before
/// node is reported removed or the after node added. Highest score first, then by ids.
pub fn possible_matches(diff: &DiffResult) -> Vec<PossibleMatch> {
    let mut list = Vec::new();
    for s in &diff.suggestions {
        let before = diff.node_by_before(&s.before);
        let after = diff.node_by_after(&s.after);
        if before.map(|n| n.status) != Some(ChangeStatus::Removed)
            && after.map(|n| n.status) != Some(ChangeStatus::Added)
        {
            continue;
        }
        let before_name = before
            .and_then(|n| n.before.as_ref().map(|b| b.label.to_string()))
            .or_else(|| before.map(|n| n.label.to_string()))
            .unwrap_or_else(|| s.before.to_string());
        let after_name = after
            .and_then(|n| n.after.as_ref().map(|a| a.label.to_string()))
            .or_else(|| after.map(|n| n.label.to_string()))
            .unwrap_or_else(|| s.after.to_string());
        list.push(PossibleMatch {
            before: PossibleMatchSide {
                id: s.before.to_string(),
                name: short_name(&before_name),
            },
            after: PossibleMatchSide {
                id: s.after.to_string(),
                name: short_name(&after_name),
            },
            score: s.score,
            reason: s.reason,
            label: s.evidence.label,
            neighbors: s.evidence.neighbors,
        });
    }
    list.sort_by(|x, y| {
        y.score
            .partial_cmp(&x.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| js::cmp_utf16(&x.before.id, &y.before.id))
            .then_with(|| js::cmp_utf16(&x.after.id, &y.after.id))
    });
    list
}

/// A score or evidence value as a whole percentage: `0.796` → `80%` (`percent`).
pub fn percent(value: f64) -> String {
    format!("{}%", js::number_to_string(js::math::round(value * 100.0)))
}

/// `formatHunk`'s title and subtitle.
pub fn titles(
    hunk: &Hunk,
    diff: &DiffResult,
    locale: kgdiff_core::Locale,
) -> Result<(String, String), KgdiffError> {
    kgdiff_core::format_hunk(hunk, diff, locale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apportions_as_typescript() {
        // Results of model.ts, computed with Node.
        assert_eq!(apportion(&[3, 1, 0, 0], 10), [8, 2, 0, 0]);
        assert_eq!(apportion(&[1, 1, 1, 1], 2), [0, 0, 1, 1]);
        assert_eq!(apportion(&[0, 0], 5), [0, 0]);
        assert_eq!(apportion(&[5, 5, 1], 10), [4, 4, 2]);
        assert_eq!(percent(0.796), "80%");
        assert_eq!(percent(0.005), "1%");
    }
}
