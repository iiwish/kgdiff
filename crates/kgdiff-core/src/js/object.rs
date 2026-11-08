//! A JavaScript object's own string-keyed properties, in the order JavaScript enumerates them.

use indexmap::IndexMap;
use indexmap::map::{IntoIter, Iter, IterMut, Keys, Values};

use super::JsStr;
use super::value::Value;

/// The members of a JSON object, enumerated as JavaScript enumerates an object's own keys
/// (`Object.keys`, `for…in`, `JSON.stringify`; ECMAScript OrdinaryOwnPropertyKeys, J-21):
/// keys that are canonical array indices (`"0"`, `"2"`, `"10"`, … up to `"4294967294"`; not
/// `"01"` or `"-1"`) first, in ascending numeric order, then every other key in insertion order.
///
/// Setting an existing key replaces its value in place, as assignment does (and as `JSON.parse`
/// does with a duplicate key, J-23); removing a key keeps the order of the others. `__proto__`
/// is an ordinary key (J-24). Every JSON object kgdiff writes is an `Object`, so its key order is
/// right by construction.
#[derive(Clone, Default, PartialEq)]
pub struct Object {
    /// Array-index keys first (ascending), then the others in insertion order.
    map: IndexMap<JsStr, Value>,
    /// How many of the first keys are array indices.
    indices: usize,
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

impl Object {
    pub fn new() -> Object {
        Object::default()
    }

    pub fn with_capacity(capacity: usize) -> Object {
        Object {
            map: IndexMap::with_capacity(capacity),
            indices: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.map.get_mut(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// Sets `key` to `value` (`object[key] = value`) and returns the previous value. A new key
    /// takes its place in JavaScript's enumeration order.
    pub fn insert(&mut self, key: impl Into<JsStr>, value: impl Into<Value>) -> Option<Value> {
        let key = key.into();
        let value = value.into();
        if let Some(slot) = self.map.get_mut(key.as_str()) {
            return Some(std::mem::replace(slot, value));
        }
        match array_index(&key) {
            None => {
                self.map.insert(key, value);
            }
            Some(index) => {
                let at = self.map.as_slice()[..self.indices]
                    .binary_search_by_key(&index, |k, _| array_index(k).unwrap_or(0))
                    .unwrap_or_else(|at| at);
                self.map.shift_insert(at, key, value);
                self.indices += 1;
            }
        }
        None
    }

    /// Removes `key` (`delete object[key]`), keeping the order of the other keys.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let (at, _, value) = self.map.shift_remove_full(key)?;
        if at < self.indices {
            self.indices -= 1;
        }
        Some(value)
    }

    /// Members in enumeration order.
    pub fn iter(&self) -> Iter<'_, JsStr, Value> {
        self.map.iter()
    }

    pub fn iter_mut(&mut self) -> IterMut<'_, JsStr, Value> {
        self.map.iter_mut()
    }

    /// Keys in enumeration order (`Object.keys`).
    pub fn keys(&self) -> Keys<'_, JsStr, Value> {
        self.map.keys()
    }

    /// Values in enumeration order (`Object.values`).
    pub fn values(&self) -> Values<'_, JsStr, Value> {
        self.map.values()
    }
}

impl std::fmt::Debug for Object {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.map.iter()).finish()
    }
}

impl<'a> IntoIterator for &'a Object {
    type Item = (&'a JsStr, &'a Value);
    type IntoIter = Iter<'a, JsStr, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.map.iter()
    }
}

impl IntoIterator for Object {
    type Item = (JsStr, Value);
    type IntoIter = IntoIter<JsStr, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.map.into_iter()
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
