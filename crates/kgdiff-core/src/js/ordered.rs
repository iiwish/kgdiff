//! JavaScript's `Map` iteration order under deletion: removing a key and setting it again moves
//! it to the end; setting an existing key keeps its place.

use std::borrow::Borrow;
use std::hash::Hash;

use super::Lookup;

/// An insertion-ordered map with `Map`'s semantics and O(1) amortized removal (`IndexMap`'s
/// order-keeping removal is linear). Removed entries leave a hole until the next compaction.
#[derive(Clone, Debug)]
pub struct OrderedMap<K, V> {
    entries: Vec<Option<(K, V)>>,
    index: Lookup<K, usize>,
}

impl<K, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        OrderedMap {
            entries: Vec::new(),
            index: Lookup::default(),
        }
    }
}

impl<K: Hash + Eq + Clone, V> OrderedMap<K, V> {
    pub fn new() -> Self {
        OrderedMap::default()
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    pub fn contains_key<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.index.contains_key(key)
    }

    pub fn get<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        let &at = self.index.get(key)?;
        self.entries[at].as_ref().map(|(_, v)| v)
    }

    pub fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        let &at = self.index.get(key)?;
        self.entries[at].as_mut().map(|(_, v)| v)
    }

    /// `map.set(key, value)`.
    pub fn insert(&mut self, key: K, value: V) {
        if let Some(&at) = self.index.get(&key) {
            self.entries[at] = Some((key, value));
            return;
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push(Some((key, value)));
    }

    /// The value under `key`, created with `create` on first use.
    pub fn get_or_insert_with(&mut self, key: K, create: impl FnOnce() -> V) -> &mut V {
        if !self.index.contains_key(&key) {
            self.insert(key.clone(), create());
        }
        let at = self.index[&key];
        &mut self.entries[at]
            .as_mut()
            .unwrap_or_else(|| unreachable!())
            .1
    }

    /// `map.delete(key)`.
    pub fn remove<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let at = self.index.remove(key)?;
        let removed = self.entries[at].take().map(|(_, v)| v);
        if self.entries.len() > 32 && self.index.len() * 2 < self.entries.len() {
            self.compact();
        }
        removed
    }

    fn compact(&mut self) {
        self.entries.retain(Option::is_some);
        for (at, entry) in self.entries.iter().enumerate() {
            if let Some((k, _)) = entry {
                self.index.insert(k.clone(), at);
            }
        }
    }

    /// Entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries
            .iter()
            .filter_map(|e| e.as_ref().map(|(k, v)| (k, v)))
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.iter().map(|(k, _)| k)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.iter().map(|(_, v)| v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_a_key_set_again_after_deletion_to_the_end() {
        let mut map: OrderedMap<u32, u32> = OrderedMap::new();
        for k in 0..40 {
            map.insert(k, k);
        }
        for k in 0..30 {
            map.remove(&k);
        }
        map.insert(31, 0);
        map.insert(5, 5);
        let keys: Vec<u32> = map.keys().copied().collect();
        assert_eq!(keys, [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 5]);
        assert_eq!(map.get(&31), Some(&0));
    }
}
