//! The namespaces of a client (`crate::client::SemiontClient`), one per flow
//! of the protocol and three beside them: `frame`, `browse`, `mark`, `bind`,
//! `gather`, `match_`, `yield_` and `beckon`; and `job`, `auth` and `system`.
//!
//! Every method returns one of seven shapes, and its name, its shape and what
//! calling it does first are a row of specs/src/client/surface.json, which
//! every SDK is held to:
//!
//! - an `async fn`: asked once, answered once;
//! - a `Running`: a long-running operation, its reports and its final value;
//! - an `Upload`: an upload's progress and the id of what it created;
//! - a `Cached`: a query, sent when its `fresh` is called;
//! - a plain `fn` that returns nothing: a signal, fire-and-forget;
//! - an `async fn` giving `Option<u64>`: a drive at the other participants,
//!   and how many the gateway reached;
//! - a typed stream: one channel's events, from now on.

mod auth;
mod beckon;
mod bind;
mod browse;
mod follow;
mod frame;
mod gather;
mod job;
mod mark;
mod match_;
mod refresher;
mod system;
mod yield_;

pub use auth::AuthNamespace;
pub use beckon::BeckonNamespace;
pub use bind::BindNamespace;
pub use browse::{BrowseNamespace, Collaborator, ResourceFilters};
pub use follow::JobEvent;
pub use frame::FrameNamespace;
pub use gather::GatherNamespace;
pub use job::JobNamespace;
pub use mark::{MarkAssistOptions, MarkNamespace};
pub use match_::MatchNamespace;
pub(crate) use refresher::Refresher;
pub use system::SystemNamespace;
pub use yield_::{CreateFromTokenOptions, YieldNamespace, stall_deadline};
