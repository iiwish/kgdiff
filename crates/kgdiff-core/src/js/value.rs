//! A JSON value as JavaScript holds it after `JSON.parse`.

use super::JsStr;
use super::object::Object;

/// A JSON value: every number is a double (J-02), text is [`JsStr`], objects are [`Object`]s
/// (array-index keys first, J-21). Attribute values, `meta` and everything kgdiff reads or writes
/// as JSON are `Value`s.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(JsStr),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_js_str(&self) -> Option<&JsStr> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(x) => Some(*x),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// A member of an object (`value[key]` when `value` is an object), else `None`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.get(key)
    }

    /// `typeof`-like name, for messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}

impl From<f64> for Value {
    fn from(x: f64) -> Value {
        Value::Number(x)
    }
}

impl From<u32> for Value {
    fn from(x: u32) -> Value {
        Value::Number(f64::from(x))
    }
}

impl From<i32> for Value {
    fn from(x: i32) -> Value {
        Value::Number(f64::from(x))
    }
}

impl From<usize> for Value {
    /// Counts and indices: exact below 2⁵³, as in JavaScript.
    #[allow(clippy::cast_precision_loss, reason = "counts stay far below 2^53")]
    fn from(x: usize) -> Value {
        Value::Number(x as f64)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::String(JsStr::from(s))
    }
}

impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::String(JsStr::from(s))
    }
}

impl From<JsStr> for Value {
    fn from(s: JsStr) -> Value {
        Value::String(s)
    }
}

impl From<&JsStr> for Value {
    fn from(s: &JsStr) -> Value {
        Value::String(s.clone())
    }
}

impl From<Object> for Value {
    fn from(object: Object) -> Value {
        Value::Object(object)
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Value {
        Value::Array(items)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    /// `None` is `null`.
    fn from(value: Option<T>) -> Value {
        value.map_or(Value::Null, Into::into)
    }
}
