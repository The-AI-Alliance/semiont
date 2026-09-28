#![forbid(unsafe_code)]

// jemalloc, not musl's malloc: under load musl's is the gateway's bottleneck
// (apps/gateway/bench/load.sh measures the difference, docs/TESTING.md has it).
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

fn main() {
    std::process::exit(semiont_gateway::app::main());
}
