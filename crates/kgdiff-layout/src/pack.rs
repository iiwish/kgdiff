//! Packing of laid-out components (`pack.ts`).
//!
//! Components are packed with a skyline bottom-left packer (tallest first) into a strip whose
//! width is chosen from a few candidates so that the picture is closest to a 16:10 viewport;
//! isolated nodes follow as a compact table (aligned columns, rows sharing a baseline) spanning
//! the same width.

use crate::math::{cmp_f64, max};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub(crate) struct Placement {
    pub x: f64,
    pub y: f64,
}

/// A node of the isolated-node table: its visual box relative to the node center.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GridItem {
    pub half_width: f64,
    /// Negative: the distance from the center to the top of the box.
    pub top: f64,
    pub bottom: f64,
}

pub(crate) struct PackInput<'a> {
    /// Bounding boxes of multi-node components.
    pub components: &'a [Size],
    pub isolated: &'a [GridItem],
    pub component_gap: f64,
    pub grid_gap_x: f64,
    pub grid_gap_y: f64,
    /// Target width / height.
    pub aspect: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PackResult {
    /// The top-left corner of each component box, by input index.
    pub components: Vec<Placement>,
    /// The node center of each isolated item, by input index.
    pub isolated: Vec<Placement>,
    pub width: f64,
    pub height: f64,
}

const WIDTH_FACTORS: [f64; 9] = [0.55, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];

#[derive(Clone, Copy)]
struct Segment {
    x: f64,
    y: f64,
    w: f64,
}

/// Skyline bottom-left placement into a strip; no box may be wider than the strip.
fn skyline(sizes: &[Size], order: &[usize], strip_width: f64) -> (Vec<Placement>, f64, f64) {
    let mut positions = vec![Placement::default(); sizes.len()];
    let mut segments = vec![Segment {
        x: 0.0,
        y: 0.0,
        w: strip_width,
    }];
    let (mut width, mut height) = (0.0, 0.0);
    let eps = 1e-9;

    for &index in order {
        let Size {
            width: w,
            height: h,
        } = sizes[index];
        let mut best_y = f64::INFINITY;
        let mut best_x = 0.0;
        for i in 0..segments.len() {
            let x = segments[i].x;
            if x + w > strip_width + eps && x > 0.0 {
                break;
            }
            let mut y: f64 = 0.0;
            let mut covered = 0.0;
            let mut j = i;
            while j < segments.len() && covered < w - eps {
                y = max(y, segments[j].y);
                covered = segments[j].x + segments[j].w - x;
                j += 1;
            }
            if y < best_y - eps {
                best_y = y;
                best_x = x;
            }
        }
        positions[index] = Placement {
            x: best_x,
            y: best_y,
        };
        width = max(width, best_x + w);
        height = max(height, best_y + h);

        // Raise the skyline over [best_x, best_x + w).
        let left = best_x;
        let right = best_x + w;
        let mut next = Vec::with_capacity(segments.len() + 2);
        for seg in &segments {
            let seg_right = seg.x + seg.w;
            if seg_right <= left + eps || seg.x >= right - eps {
                next.push(*seg);
                continue;
            }
            if seg.x < left {
                next.push(Segment {
                    x: seg.x,
                    y: seg.y,
                    w: left - seg.x,
                });
            }
            if seg_right > right {
                next.push(Segment {
                    x: right,
                    y: seg.y,
                    w: seg_right - right,
                });
            }
        }
        next.push(Segment {
            x: left,
            y: best_y + h,
            w,
        });
        next.sort_by(|a, b| cmp_f64(a.x, b.x));
        segments.clear();
        for seg in next {
            match segments.last_mut() {
                Some(last) if (last.y - seg.y).abs() < eps => last.w = seg.x + seg.w - last.x,
                _ => segments.push(seg),
            }
        }
    }
    (positions, width, height)
}

/// The table of isolated nodes with the largest column count that fits `target_width`.
fn grid(
    items: &[GridItem],
    gap_x: f64,
    gap_y: f64,
    target_width: f64,
) -> (Vec<Placement>, f64, f64) {
    let n = items.len();
    if n == 0 {
        return (Vec::new(), 0.0, 0.0);
    }
    let column_width = |col: usize, columns: usize| {
        let mut w: f64 = 0.0;
        let mut i = col;
        while i < n {
            w = max(w, 2.0 * items[i].half_width);
            i += columns;
        }
        w
    };
    let table_width = |columns: usize| {
        let mut total = gap_x * (columns - 1) as f64;
        for col in 0..columns {
            total += column_width(col, columns);
        }
        total
    };
    let mut columns = 1;
    while columns < n && table_width(columns + 1) <= target_width {
        columns += 1;
    }

    let mut col_center = Vec::with_capacity(columns);
    let mut cursor = 0.0;
    for col in 0..columns {
        let w = column_width(col, columns);
        col_center.push(cursor + w / 2.0);
        cursor += w + gap_x;
    }
    let width = cursor - gap_x;

    let mut centers = vec![Placement::default(); n];
    let mut top = 0.0;
    let mut row = 0;
    while row * columns < n {
        let (start, end) = (row * columns, n.min((row + 1) * columns));
        let (mut above, mut below): (f64, f64) = (0.0, 0.0);
        for item in &items[start..end] {
            above = max(above, -item.top);
            below = max(below, item.bottom);
        }
        for (i, center) in centers.iter_mut().enumerate().take(end).skip(start) {
            *center = Placement {
                x: col_center[i - start],
                y: top + above,
            };
        }
        top += above + below + gap_y;
        row += 1;
    }
    (centers, width, top - gap_y)
}

/// The area of the smallest `aspect` rectangle enclosing width × height.
fn enclosing_area(width: f64, height: f64, aspect: f64) -> f64 {
    let w = max(width, height * aspect);
    w * (w / aspect)
}

pub(crate) fn pack(input: &PackInput<'_>) -> PackResult {
    let aspect = input.aspect;
    let gap = input.component_gap;
    let inflated: Vec<Size> = input
        .components
        .iter()
        .map(|s| Size {
            width: s.width + gap,
            height: s.height + gap,
        })
        .collect();
    let mut order: Vec<usize> = (0..inflated.len()).collect();
    order.sort_by(|&a, &b| {
        cmp_f64(inflated[b].height, inflated[a].height)
            .then(cmp_f64(inflated[b].width, inflated[a].width))
            .then(a.cmp(&b))
    });
    let mut area = 0.0;
    let mut widest: f64 = 0.0;
    for s in &inflated {
        area += s.width * s.height;
        widest = max(widest, s.width);
    }
    for item in input.isolated {
        area += (2.0 * item.half_width + input.grid_gap_x)
            * (item.bottom - item.top + input.grid_gap_y);
        widest = max(widest, 2.0 * item.half_width);
    }
    let base = (area * aspect).sqrt();

    let mut best: Option<PackResult> = None;
    let mut best_cost = f64::INFINITY;
    let mut tried: Vec<f64> = Vec::with_capacity(WIDTH_FACTORS.len());
    for factor in WIDTH_FACTORS {
        let strip = max(widest, base * factor);
        if tried.contains(&strip) {
            continue;
        }
        tried.push(strip);
        let (positions, packed_width, packed_height) = skyline(&inflated, &order, strip);
        let comp_width = if packed_width > 0.0 {
            packed_width - gap
        } else {
            0.0
        };
        let comp_height = if packed_height > 0.0 {
            packed_height - gap
        } else {
            0.0
        };
        let (centers, table_width, table_height) = grid(
            input.isolated,
            input.grid_gap_x,
            input.grid_gap_y,
            max(strip - gap, comp_width),
        );
        let table_top = if comp_height > 0.0 && table_height > 0.0 {
            comp_height + gap
        } else {
            0.0
        };
        let width = max(comp_width, table_width);
        let height = if table_height > 0.0 {
            table_top + table_height
        } else {
            comp_height
        };
        let cost = enclosing_area(width, height, aspect);
        if cost < best_cost - 1e-6 {
            best_cost = cost;
            best = Some(PackResult {
                components: positions,
                isolated: centers
                    .iter()
                    .map(|c| Placement {
                        x: c.x,
                        y: c.y + table_top,
                    })
                    .collect(),
                width,
                height,
            });
        }
    }
    best.unwrap_or_default()
}
