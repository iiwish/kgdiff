//! The error every kgdiff function returns (`KgdiffError` of `@kgdiff/core`).

use std::fmt;

use crate::js::Object;

/// The stable error codes (`KgdiffErrorCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    InvalidInput,
    DanglingEdge,
    DeltaBaseMismatch,
    DeltaConflict,
    UnsupportedVersion,
}

impl ErrorCode {
    /// The code as written in TypeScript (`invalid-input`, …).
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

/// An error with a stable code, kgdiff's message and optional details, as `KgdiffError`.
#[derive(Clone, Debug, PartialEq)]
pub struct KgdiffError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<Object>,
}

impl KgdiffError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> KgdiffError {
        KgdiffError {
            code,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
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

pub type Result<T, E = KgdiffError> = std::result::Result<T, E>;
