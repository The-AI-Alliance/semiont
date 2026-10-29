//! A state unit: a piece of a client's state with a reactive surface and one
//! structural commitment, `dispose`.
//!
//! Its surface is methods that return what it holds as state
//! (`tokio::sync::watch` receivers) or what happens to it as events
//! (streams); the senders stay private, so nothing outside the unit can
//! write past its logic. What the pattern asks beyond the trait:
//!
//! - `dispose` is idempotent and total, and the unit is inert after it;
//! - disposing drops every sender the unit owns, so its receivers end;
//! - a dependency it was given is never disposed by it, and a child it made
//!   is disposed with it;
//! - no state outside its instances: two units never move each other.
//!
//! A unit's `Drop` calls `dispose`, so one that is simply dropped leaks
//! nothing. `semiont::testing::axioms` checks each of these against a unit.

pub trait StateUnit {
    fn dispose(&self);
}
