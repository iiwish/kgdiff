//! The error every fallible kgdiff function returns.

use std::fmt;

use crate::js::Object;

/// The stable error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorCode {
    /// The input is not a valid graph, delta, option set or document.
    InvalidInput,
    /// An edge names an endpoint that is not a node (with `DanglingEdges::Error`).
    DanglingEdge,
    /// The delta's base hash differs from the hash of the graph it is applied to.
    DeltaBaseMismatch,
    /// An operation's precondition does not hold in strict mode.
    DeltaConflict,
    /// The document's `version` is newer than this library reads.
    UnsupportedVersion,
}

impl ErrorCode {
    /// The code as written in kgdiff messages (`invalid-input`, `delta-conflict`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidInput => "invalid-input",
            ErrorCode::DanglingEdge => "dangling-edge",
            ErrorCode::DeltaBaseMismatch => "delta-base-mismatch",
            ErrorCode::DeltaConflict => "delta-conflict",
            ErrorCode::UnsupportedVersion => "unsupported-version",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error with a stable code, a message and optional details.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct KgdiffError {
    /// The stable code to match on.
    pub code: ErrorCode,
    /// A human-readable message.
    pub message: String,
    /// Structured details of the failure, when there are any (for example `opIndex`, `op` and `reason` of a delta conflict).
    pub details: Option<Object>,
}

impl KgdiffError {
    /// Creates an error with a code and a message, and no details.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> KgdiffError {
        KgdiffError {
            code,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    /// Attaches structured details to the error.
    pub fn with_details(mut self, details: Object) -> KgdiffError {
        self.details = Some(details);
        self
    }

    /// `KgdiffError('invalid-input', message)`.
    pub fn invalid_input(message: impl Into<String>) -> KgdiffError {
        KgdiffError::new(ErrorCode::InvalidInput, message)
    }
}

impl fmt::Display for KgdiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for KgdiffError {}

/// The result of the kgdiff functions: `Ok` or a [`KgdiffError`].
pub type Result<T, E = KgdiffError> = std::result::Result<T, E>;
