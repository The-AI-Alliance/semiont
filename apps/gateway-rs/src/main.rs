#[global_allocator]
static ALLOCATOR: semiont_gateway::alloc::Counting = semiont_gateway::alloc::Counting;

fn main() {
    std::process::exit(semiont_gateway::app::main());
}
