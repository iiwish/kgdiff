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
    map: HashMap<K, V>,
}

impl<K, V> Default for Lookup<K, V> {
    fn default() -> Self {
        Lookup {
            map: HashMap::new(),
        }
    }
}

impl<K: Hash + Eq, V> Lookup<K, V> {
    pub fn new() -> Self {
        Lookup::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Lookup {
            map: HashMap::with_capacity(capacity),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.map.get(key)
    }

    pub fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.map.get_mut(key)
    }

    pub fn contains_key<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.map.contains_key(key)
    }

    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        self.map.insert(key, value)
    }

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
