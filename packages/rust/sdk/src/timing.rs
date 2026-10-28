//! The timing a client keeps: its deadlines, its retry budgets and the
//! cadence of its stream, generated from specs/src/client/timing.json, so one
//! client waits as long, and tries as often, as another. A transport takes
//! overrides of the ones a test must not wait out.

include!(concat!(env!("OUT_DIR"), "/timing.rs"));
