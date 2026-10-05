//! Where a key is filed: the two directory levels under which a resource's
//! stream and view, a storage-uri entry and an anchored-text entry are kept.
//!
//! The arithmetic is the one every reader and writer of those files shares,
//! in any language; specs/src/archivist/shard-cases.json holds each to it.

/// How many shards there are: one for each value of four hex digits.
const SHARDS: u32 = 65536;

/// A key's shard, of `SHARDS`.
///
/// Computed over the key's UTF-16 code units: start at 0; for each unit,
/// multiply by 31 and add the unit, keeping the low 32 bits as a signed
/// integer; take the absolute value; take it modulo the number of shards.
fn shard(key: &str) -> u32 {
    let hash = key.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    });
    hash.unsigned_abs() % SHARDS
}

/// The two directory names a key is filed under: its shard as four lowercase
/// hex digits, split in two.
pub fn shard_path(key: &str) -> (String, String) {
    let hex = format!("{:04x}", shard(key));
    (hex[..2].to_owned(), hex[2..].to_owned())
}

#[cfg(test)]
mod tests {
    use super::shard;

    #[test]
    fn the_absolute_value_of_the_least_integer_is_in_range() {
        // i32::MIN has no positive counterpart; its absolute value is 2^31,
        // which is a multiple of the number of shards.
        assert_eq!(i32::MIN.unsigned_abs() % super::SHARDS, 0);
        assert_eq!(shard(""), 0);
    }
}
