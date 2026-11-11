//! A failure of the engine as the bindings report it: thrown as the JSON text of `{ code, message,
//! details }`, which `packages/compute` turns into a `KgdiffError`.

use kgdiff_core::js::{Object, Value, json};
use kgdiff_core::{ErrorCode, KgdiffError};
use wasm_bindgen::JsValue;

/// A failure, as `KgdiffError` of `@kgdiff/core` has it.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub details: Option<Object>,
}

impl Failure {
    pub fn invalid_input(message: String) -> Failure {
        Failure {
            code: ErrorCode::InvalidInput.as_str(),
            message,
            details: None,
        }
    }

    /// `{"code": …, "message": …, "details": …}`, which the JavaScript glue turns into a
    /// `KgdiffError`.
    pub fn to_json(&self) -> String {
        let mut out = Object::new();
        out.insert("code", self.code);
        out.insert("message", self.message.as_str());
        if let Some(details) = &self.details {
            out.insert("details", details.clone());
        }
        json::to_string(&Value::Object(out))
    }
}

impl From<KgdiffError> for Failure {
    fn from(error: KgdiffError) -> Failure {
        Failure {
            code: error.code.as_str(),
            message: error.message,
            details: error.details,
        }
    }
}

pub type Result<T> = std::result::Result<T, Failure>;

/// A result as wasm-bindgen throws it.
pub(crate) fn thrown<T>(result: Result<T>) -> std::result::Result<T, JsValue> {
    result.map_err(|failure| JsValue::from_str(&failure.to_json()))
}
