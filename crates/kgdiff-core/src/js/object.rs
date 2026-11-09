//! A JavaScript object's own string-keyed properties, in the order JavaScript enumerates them.

use super::value::Value;
use super::{JsStr, Lookup};

/// Objects with more members than this get a hash index; smaller ones are scanned, which is
/// faster than hashing for the few members of most records.
const SMALL: usize = 8;

/// The members of a JSON object, enumerated as JavaScript enumerates an object's own keys
/// (`Object.keys`, `for…in`, `JSON.stringify`; ECMAScript OrdinaryOwnPropertyKeys, J-21):
/// keys that are canonical array indices (`"0"`, `"2"`, `"10"`, … up to `"4294967294"`; not
/// `"01"` or `"-1"`) first, in ascending numeric order, then every other key in insertion order.
///
/// Setting an existing key replaces its value in place, as assignment does (and as `JSON.parse`
/// does with a duplicate key, J-23); removing a key keeps the order of the others. `__proto__`
/// is an ordinary key (J-24). Every JSON object kgdiff writes is an `Object`, so its key order is
/// right by construction. Equality ignores the order of the members, as for a map.
#[derive(Clone, Default)]
pub struct Object {
    /// Array-index keys first (ascending), then the others in insertion order.
    entries: Vec<(JsStr, Value)>,
    /// How many of the first keys are array indices.
    indices: usize,
    /// Positions by key, once the object has more than `SMALL` members.
    index: Option<Lookup<JsStr, usize>>,
}

/// The numeric value of a canonical array-index key, or `None`.
pub fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes[0] == b'0' && bytes.len() > 1) {
        return None;
    }
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    // 2³² − 1 is not an array index.
    u32::try_from(value).ok().filter(|&v| v != u32::MAX)
}

type Entry = (JsStr, Value);

fn pair(entry: &Entry) -> (&JsStr, &Value) {
    (&entry.0, &entry.1)
}

fn pair_mut(entry: &mut Entry) -> (&JsStr, &mut Value) {
    (&entry.0, &mut entry.1)
}

impl Object {
    pub fn new() -> Object {
        Object::default()
    }

    pub fn with_capacity(capacity: usize) -> Object {
        Object {
            entries: Vec::with_capacity(capacity),
            indices: 0,
            index: None,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn position(&self, key: &str) -> Option<usize> {
        match &self.index {
            Some(index) => index.get(key).copied(),
            None => self.entries.iter().position(|(k, _)| k.as_str() == key),
        }
    }

    fn reindex(&mut self) {
        self.index = (self.entries.len() > SMALL).then(|| {
            let mut index = Lookup::with_capacity(self.entries.len());
            for (at, (k, _)) in self.entries.iter().enumerate() {
                index.insert(k.clone(), at);
            }
            index
        });
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.position(key).map(|at| &self.entries[at].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.position(key).map(|at| &mut self.entries[at].1)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.position(key).is_some()
    }

    /// Sets `key` to `value` (`object[key] = value`) and returns the previous value. A new key
    /// takes its place in JavaScript's enumeration order.
    pub fn insert(&mut self, key: impl Into<JsStr>, value: impl Into<Value>) -> Option<Value> {
        let key = key.into();
        let value = value.into();
        if let Some(at) = self.position(&key) {
            return Some(std::mem::replace(&mut self.entries[at].1, value));
        }
        let at = match array_index(&key) {
            None => self.entries.len(),
            Some(number) => {
                let at = self.entries[..self.indices]
                    .binary_search_by_key(&number, |(k, _)| array_index(k).unwrap_or(0))
                    .unwrap_or_else(|at| at);
                self.indices += 1;
                at
            }
        };
        if at == self.entries.len() {
            if let Some(index) = &mut self.index {
                index.insert(key.clone(), at);
            }
            self.entries.push((key, value));
            if self.index.is_none() && self.entries.len() > SMALL {
                self.reindex();
            }
        } else {
            self.entries.insert(at, (key, value));
            if self.index.is_some() || self.entries.len() > SMALL {
                self.reindex();
            }
        }
        None
    }

    /// Removes `key` (`delete object[key]`), keeping the order of the other keys.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let at = self.position(key)?;
        let (_, value) = self.entries.remove(at);
        if at < self.indices {
            self.indices -= 1;
        }
        if self.index.is_some() {
            self.reindex();
        }
        Some(value)
    }

    /// Members in enumeration order.
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&JsStr, &Value)> + ExactSizeIterator {
        self.entries.iter().map(pair)
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&JsStr, &mut Value)> {
        self.entries.iter_mut().map(pair_mut)
    }

    /// Keys in enumeration order (`Object.keys`).
    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &JsStr> + ExactSizeIterator {
        self.entries.iter().map(|(k, _)| k)
    }

    /// Values in enumeration order (`Object.values`).
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &Value> + ExactSizeIterator {
        self.entries.iter().map(|(_, v)| v)
    }
}

impl PartialEq for Object {
    /// The same members with equal values, in any order.
    fn eq(&self, other: &Object) -> bool {
        self.len() == other.len() && self.iter().all(|(k, v)| other.get(k) == Some(v))
    }
}

impl std::fmt::Debug for Object {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl<'a> IntoIterator for &'a Object {
    type Item = (&'a JsStr, &'a Value);
    type IntoIter =
        std::iter::Map<std::slice::Iter<'a, Entry>, fn(&'a Entry) -> (&'a JsStr, &'a Value)>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter().map(pair)
    }
}

impl IntoIterator for Object {
    type Item = (JsStr, Value);
    type IntoIter = std::vec::IntoIter<Entry>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<K: Into<JsStr>, V: Into<Value>> FromIterator<(K, V)> for Object {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Object {
        let mut object = Object::new();
        for (key, value) in iter {
            object.insert(key, value);
        }
        object
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(object: &Object) -> Vec<&str> {
        object.keys().map(JsStr::as_str).collect()
    }

    #[test]
    fn enumerates_array_indices_first() {
        let object: Object = [("b", 1.0), ("10", 2.0), ("2", 3.0), ("a", 4.0), ("b", 5.0)]
            .into_iter()
            .collect();
        assert_eq!(keys(&object), ["2", "10", "b", "a"]);
        assert_eq!(object.get("b"), Some(&Value::Number(5.0)));
        let object: Object = ["01", "1", "-1", "1.0", "4294967294", "4294967295", "0"]
            .map(|k| (k, 0.0))
            .into_iter()
            .collect();
        assert_eq!(
            keys(&object),
            ["0", "1", "4294967294", "01", "-1", "1.0", "4294967295"]
        );
    }

    #[test]
    fn keeps_the_order_past_the_small_size() {
        let mut object = Object::new();
        for k in [
            "k9", "k1", "5", "k3", "k4", "1", "k6", "k7", "k8", "k0", "3",
        ] {
            object.insert(k, 0.0);
        }
        assert_eq!(
            keys(&object),
            [
                "1", "3", "5", "k9", "k1", "k3", "k4", "k6", "k7", "k8", "k0"
            ]
        );
        object.insert("k1", 1.0);
        assert_eq!(object.get("k1"), Some(&Value::Number(1.0)));
        assert_eq!(object.remove("3"), Some(Value::Number(0.0)));
        assert_eq!(object.get("k0"), Some(&Value::Number(0.0)));
        assert_eq!(keys(&object)[..3], ["1", "5", "k9"]);
    }

    #[test]
    fn removes_keys_in_place() {
        let mut object: Object = [("x", 1.0), ("3", 2.0), ("y", 3.0), ("1", 4.0)]
            .into_iter()
            .collect();
        assert_eq!(object.remove("3"), Some(Value::Number(2.0)));
        assert_eq!(object.remove("x"), Some(Value::Number(1.0)));
        object.insert("2", 5.0);
        object.insert("x", 6.0);
        assert_eq!(keys(&object), ["1", "2", "y", "x"]);
    }
}
