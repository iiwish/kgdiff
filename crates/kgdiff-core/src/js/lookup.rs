//! Hash lookups without iteration (RFC 0002, §3 rule 1).

#![allow(
    clippy::disallowed_types,
    reason = "the one wrapper around HashMap, without iteration"
)]

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;

/// A hash map for lookups only: it has no iteration API, so its unspecified order can never
/// reach a result. Ordered collections are `IndexMap` / `IndexSet` (insertion order, like
/// JavaScript's `Map` and `Set`) or sorted vectors.
#[derive(Clone, Debug)]
pub struct Lookup<K, V> {
    map: HashMap<K, V, super::BuildHasher>,
}

impl<K, V> Default for Lookup<K, V> {
    fn default() -> Self {
        Lookup {
            map: HashMap::default(),
        }
    }
}

impl<K: Hash + Eq, V> Lookup<K, V> {
    /// Creates an empty map.
    pub fn new() -> Self {
        Lookup::default()
    }

    /// Creates an empty map with room for `capacity` entries.
    pub fn with_capacity(capacity: usize) -> Self {
        Lookup {
            map: HashMap::with_capacity_and_hasher(capacity, super::BuildHasher::default()),
        }
    }

    /// The number of entries.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Whether the map has no entries.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// The value for `key`, if any.
    pub fn get<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.map.get(key)
    }

    /// The value for `key`, mutably.
    pub fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.map.get_mut(key)
    }

    /// Whether `key` has a value.
    pub fn contains_key<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.map.contains_key(key)
    }

    /// Sets the value for `key`, returning the previous one.
    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        self.map.insert(key, value)
    }

    /// Removes `key`, returning its value.
    pub fn remove<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        self.map.remove(key)
    }

    /// The value under `key`, created with `create` on first use (`getOrCreate`).
    pub fn get_or_insert_with(&mut self, key: K, create: impl FnOnce() -> V) -> &mut V {
        self.map.entry(key).or_insert_with(create)
    }
}

impl<K: Hash + Eq + Borrow<Q>, Q: Hash + Eq + ?Sized, V> std::ops::Index<&Q> for Lookup<K, V> {
    type Output = V;

    /// The value under `key`.
    ///
    /// # Panics
    ///
    /// When there is none, as `HashMap` indexing does.
    fn index(&self, key: &Q) -> &V {
        self.map.get(key).expect("no entry for the key")
    }
}
