//! The allocator's own count of what is in use: the heap gauge's `used`.

/// Bytes allocated and not yet freed, as of jemalloc's latest epoch.
pub fn in_use() -> usize {
    let _ = tikv_jemalloc_ctl::epoch::advance();
    tikv_jemalloc_ctl::stats::allocated::read().unwrap_or(0)
}
