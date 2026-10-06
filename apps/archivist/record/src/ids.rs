//! Identifiers: the rule an id is held to wherever it names a file, and how
//! the Archivist mints one.

use crate::RecordError;

/// Whether `id` is 1 to 128 of the letters, the digits, `_` and `-`.
pub fn is_safe(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `id`, if it may name a file or a directory.
pub fn safe(id: &str) -> Result<&str, RecordError> {
    if is_safe(id) {
        Ok(id)
    } else {
        Err(RecordError(format!(
            "{id:?} is not an id: an id is 1 to 128 of the letters, the digits, _ and -"
        )))
    }
}

/// A fresh id: 32 lowercase hex digits.
pub fn mint() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
