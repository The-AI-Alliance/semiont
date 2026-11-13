//! A transport's failures, for a test that awaits them: the tests of this
//! crate that hear what the transport meets take it as a module.

use semiont::errors::TransportError;
use semiont::transport::Transport;
use tokio::sync::mpsc;

/// Each failure `transport` tells a listener taken now, in the order told.
/// They end once the transport closes, which lets go of the listener.
pub fn failures_told(transport: &impl Transport) -> mpsc::UnboundedReceiver<TransportError> {
    let (telling, told) = mpsc::unbounded_channel();
    transport.tell_failures_to(Box::new(move |failure| {
        let _ = telling.send(failure.clone());
    }));
    told
}
