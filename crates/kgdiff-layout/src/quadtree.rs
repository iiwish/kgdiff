//! The part of d3-quadtree the layout uses (`addAll` with `cover`, `visit`, `visitAfter`,
//! `extent`), as an arena: every cell is an index into flat arrays, and the per-cell values of
//! the forces live in arrays of their own, indexed the same way.
//!
//! The structure is d3's: the extent starts as the unit square at the floor of the first point
//! and doubles until it covers every point, a cell splits until two points separate, and points
//! with exactly equal coordinates share a leaf as a list (the newest first). The traversal orders
//! are d3's too, so that the order of floating-point accumulation is fixed (RFC 0002, §5: byte
//! equality with d3 is not required, a fixed order within Rust is).

pub(crate) const NONE: u32 = u32::MAX;

fn index(i: usize) -> u32 {
    u32::try_from(i).expect("fewer than 2³² cells")
}

/// A quadtree over points given by index (`xs[d]`, `ys[d]`).
#[derive(Clone, Debug)]
pub(crate) struct Quadtree {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    root: u32,
    /// Per cell: a leaf (the first of a list of coincident points) or an internal cell.
    leaf: Vec<bool>,
    /// Per cell: an internal cell's children by quadrant (`bottom << 1 | right`, `NONE` when
    /// empty), or a leaf's datum and the next coincident leaf.
    slots: Vec<[u32; 4]>,
}

impl Default for Quadtree {
    fn default() -> Quadtree {
        Quadtree {
            x0: f64::NAN,
            y0: f64::NAN,
            x1: f64::NAN,
            y1: f64::NAN,
            root: NONE,
            leaf: Vec::new(),
            slots: Vec::new(),
        }
    }
}

impl Quadtree {
    /// Clears the tree for reuse, keeping its allocations.
    pub(crate) fn clear(&mut self) {
        self.x0 = f64::NAN;
        self.y0 = f64::NAN;
        self.x1 = f64::NAN;
        self.y1 = f64::NAN;
        self.root = NONE;
        self.leaf.clear();
        self.slots.clear();
    }

    pub(crate) fn root(&self) -> Option<u32> {
        (self.root != NONE).then_some(self.root)
    }

    /// The number of cells (leaves included): per-cell arrays have this length.
    pub(crate) fn len(&self) -> usize {
        self.leaf.len()
    }

    #[inline]
    pub(crate) fn is_leaf(&self, cell: u32) -> bool {
        self.leaf[cell as usize]
    }

    /// The children of an internal cell by quadrant, `NONE` where empty.
    #[inline]
    pub(crate) fn children(&self, cell: u32) -> [u32; 4] {
        self.slots[cell as usize]
    }

    /// The datum of a leaf.
    #[inline]
    pub(crate) fn datum(&self, leaf: u32) -> usize {
        self.slots[leaf as usize][0] as usize
    }

    /// The next leaf of a list of coincident points.
    #[inline]
    pub(crate) fn next(&self, leaf: u32) -> Option<u32> {
        let next = self.slots[leaf as usize][1];
        (next != NONE).then_some(next)
    }

    fn new_internal(&mut self) -> u32 {
        self.leaf.push(false);
        self.slots.push([NONE; 4]);
        index(self.leaf.len() - 1)
    }

    fn new_leaf(&mut self, d: usize) -> u32 {
        self.leaf.push(true);
        self.slots.push([index(d), NONE, NONE, NONE]);
        index(self.leaf.len() - 1)
    }

    /// `quadtree.addAll(items)` with `x(d) = xs[d]`, `y(d) = ys[d]`, on an empty tree.
    pub(crate) fn add_all(&mut self, items: &[usize], xs: &[f64], ys: &[f64]) {
        let (mut x0, mut y0) = (f64::INFINITY, f64::INFINITY);
        let (mut x1, mut y1) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for &d in items {
            let (x, y) = (xs[d], ys[d]);
            if x.is_nan() || y.is_nan() {
                continue;
            }
            if x < x0 {
                x0 = x;
            }
            if x > x1 {
                x1 = x;
            }
            if y < y0 {
                y0 = y;
            }
            if y > y1 {
                y1 = y;
            }
        }
        if x0 > x1 || y0 > y1 {
            return;
        }
        self.cover(x0, y0);
        self.cover(x1, y1);
        self.leaf.reserve(2 * items.len());
        self.slots.reserve(2 * items.len());
        for &d in items {
            self.add(xs[d], ys[d], d, xs, ys);
        }
    }

    /// `quadtree.cover(x, y)`: grows the extent (doubling it) until it contains (x, y).
    fn cover(&mut self, x: f64, y: f64) {
        if x.is_nan() || y.is_nan() {
            return;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (self.x0, self.y0, self.x1, self.y1);
        if x0.is_nan() {
            x0 = x.floor();
            x1 = x0 + 1.0;
            y0 = y.floor();
            y1 = y0 + 1.0;
        } else {
            let mut z = x1 - x0;
            if z == 0.0 || z.is_nan() {
                z = 1.0;
            }
            // d3 wraps the root only when it is an internal cell; a leaf root stays the root.
            let wraps = self.root != NONE && !self.is_leaf(self.root);
            let mut node = self.root;
            while x0 > x || x >= x1 || y0 > y || y >= y1 {
                let i = (usize::from(y < y0) << 1) | usize::from(x < x0);
                if wraps {
                    let parent = self.new_internal();
                    self.slots[parent as usize][i] = node;
                    node = parent;
                }
                z *= 2.0;
                match i {
                    0 => {
                        x1 = x0 + z;
                        y1 = y0 + z;
                    }
                    1 => {
                        x0 = x1 - z;
                        y1 = y0 + z;
                    }
                    2 => {
                        x1 = x0 + z;
                        y0 = y1 - z;
                    }
                    _ => {
                        x0 = x1 - z;
                        y0 = y1 - z;
                    }
                }
            }
            if wraps {
                self.root = node;
            }
        }
        self.x0 = x0;
        self.y0 = y0;
        self.x1 = x1;
        self.y1 = y1;
    }

    /// Puts `cell` where the walk came from: a quadrant of `parent`, or the root.
    fn put(&mut self, parent: Option<(u32, usize)>, cell: u32) {
        match parent {
            Some((p, i)) => self.slots[p as usize][i] = cell,
            None => self.root = cell,
        }
    }

    /// d3-quadtree's `add(tree, x, y, d)`; `xs` / `ys` give the coordinates of stored data.
    fn add(&mut self, x: f64, y: f64, d: usize, xs: &[f64], ys: &[f64]) {
        if x.is_nan() || y.is_nan() {
            return;
        }
        let leaf = self.new_leaf(d);
        if self.root == NONE {
            self.root = leaf;
            return;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (self.x0, self.y0, self.x1, self.y1);
        let mut parent: Option<(u32, usize)> = None;
        let mut node = self.root;
        // Find the existing leaf for the new point, or an empty quadrant for it.
        while !self.is_leaf(node) {
            let xm = (x0 + x1) / 2.0;
            let right = x >= xm;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            let ym = (y0 + y1) / 2.0;
            let bottom = y >= ym;
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            let i = (usize::from(bottom) << 1) | usize::from(right);
            parent = Some((node, i));
            let child = self.slots[node as usize][i];
            if child == NONE {
                self.slots[node as usize][i] = leaf;
                return;
            }
            node = child;
        }
        let existing = node;
        let datum = self.datum(existing);
        let (xp, yp) = (xs[datum], ys[datum]);
        // Exactly coincident with the existing point: the new leaf heads the list.
        if x == xp && y == yp {
            self.slots[leaf as usize][1] = existing;
            self.put(parent, leaf);
            return;
        }
        // Otherwise split the leaf's cell until the old and the new point separate.
        loop {
            let cell = self.new_internal();
            self.put(parent, cell);
            let xm = (x0 + x1) / 2.0;
            let right = x >= xm;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            let ym = (y0 + y1) / 2.0;
            let bottom = y >= ym;
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            let i = (usize::from(bottom) << 1) | usize::from(right);
            let j = (usize::from(yp >= ym) << 1) | usize::from(xp >= xm);
            if i != j {
                self.slots[cell as usize][j] = existing;
                self.slots[cell as usize][i] = leaf;
                return;
            }
            parent = Some((cell, i));
        }
    }

    /// `quadtree.visit(callback)`: pre-order from the root, quadrants 0, 1, 2, 3; the children of
    /// a cell are skipped when `callback(cell, x0, y0, x1, y1)` returns true. `stack` is reused
    /// scratch space.
    pub(crate) fn visit(
        &self,
        stack: &mut Vec<(u32, [f64; 4])>,
        mut callback: impl FnMut(u32, f64, f64, f64, f64) -> bool,
    ) {
        stack.clear();
        if self.root != NONE {
            stack.push((self.root, [self.x0, self.y0, self.x1, self.y1]));
        }
        while let Some((node, [x0, y0, x1, y1])) = stack.pop() {
            if callback(node, x0, y0, x1, y1) || self.is_leaf(node) {
                continue;
            }
            let [c0, c1, c2, c3] = self.children(node);
            let xm = (x0 + x1) / 2.0;
            let ym = (y0 + y1) / 2.0;
            if c3 != NONE {
                stack.push((c3, [xm, ym, x1, y1]));
            }
            if c2 != NONE {
                stack.push((c2, [x0, ym, xm, y1]));
            }
            if c1 != NONE {
                stack.push((c1, [xm, y0, x1, ym]));
            }
            if c0 != NONE {
                stack.push((c0, [x0, y0, xm, ym]));
            }
        }
    }

    /// The order of `quadtree.visitAfter(callback)`'s calls: every cell after all of its
    /// descendants. `stack` and `order` are reused scratch space.
    pub(crate) fn post_order(&self, stack: &mut Vec<u32>, order: &mut Vec<u32>) {
        stack.clear();
        order.clear();
        if self.root != NONE {
            stack.push(self.root);
        }
        while let Some(node) = stack.pop() {
            if !self.is_leaf(node) {
                for child in self.children(node) {
                    if child != NONE {
                        stack.push(child);
                    }
                }
            }
            order.push(node);
        }
        order.reverse();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaves(tree: &Quadtree) -> Vec<Vec<usize>> {
        let mut out = Vec::new();
        let mut stack = Vec::new();
        tree.visit(&mut stack, |cell, _, _, _, _| {
            if tree.is_leaf(cell) {
                let mut list = vec![tree.datum(cell)];
                let mut leaf = cell;
                while let Some(next) = tree.next(leaf) {
                    list.push(tree.datum(next));
                    leaf = next;
                }
                out.push(list);
            }
            false
        });
        out
    }

    #[test]
    fn builds_d3s_tree() {
        let xs = [0.5, 3.5, 3.5, 1.25, -2.0];
        let ys = [0.5, 0.5, 0.5, 2.75, -1.0];
        let mut tree = Quadtree::default();
        tree.add_all(&[0, 1, 2, 3, 4], &xs, &ys);
        // floor(-2) = -2, then doubled until 3.5 is covered: [-2, 6).
        assert_eq!((tree.x0, tree.y0, tree.x1, tree.y1), (-2.0, -1.0, 6.0, 7.0));
        // Pre-order, quadrants 0..3; coincident points 1 and 2 share a leaf, newest first.
        assert_eq!(leaves(&tree), [vec![4], vec![0], vec![3], vec![2, 1]]);
        let mut order = Vec::new();
        tree.post_order(&mut Vec::new(), &mut order);
        // Every cell but the coincident leaf behind another (it hangs off a list, not a quadrant).
        assert_eq!(order.len(), tree.len() - 1);
        assert_eq!(order.last().copied(), tree.root());
    }

    #[test]
    fn keeps_a_single_point_as_a_leaf_root() {
        let mut tree = Quadtree::default();
        tree.add_all(&[0], &[10.5], &[-3.25]);
        assert_eq!(tree.root(), Some(0));
        assert!(tree.is_leaf(0));
        assert_eq!(
            (tree.x0, tree.x1, tree.y0, tree.y1),
            (10.0, 11.0, -4.0, -3.0)
        );
        tree.clear();
        tree.add_all(&[], &[], &[]);
        assert_eq!(tree.root(), None);
        assert!(tree.x0.is_nan());
    }
}
