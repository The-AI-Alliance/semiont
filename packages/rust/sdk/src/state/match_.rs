//! Matching, run for whoever asks on the client's own bus.
//!
//! A search is asked for by a signal (`client.match_.request_search`), which
//! carries a correlation id. This unit runs it, and answers on the same bus
//! under the same id: `match:search-results`, or `match:search-failed` with
//! the reference it was for and what went wrong. It holds no state of its
//! own: what it found is what it said.

use super::{Tasks, said, signal};
use crate::channels::{Channel, MatchSearchFailed, MatchSearchRequested, MatchSearchResults};
use crate::client::SemiontClient;
use crate::event_bus::BusFrames;
use crate::state_unit::StateUnit;
use crate::transport::Envelope;
use crate::types;
use std::sync::Arc;

struct Shared {
    client: Arc<SemiontClient>,
    tasks: Tasks,
}

/// See the module's documentation.
pub struct MatchStateUnit {
    shared: Arc<Shared>,
}

impl MatchStateUnit {
    pub fn new(client: Arc<SemiontClient>) -> MatchStateUnit {
        let heard = client.bus().frames(MatchSearchRequested::NAME);
        let shared = Arc::new(Shared {
            client,
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        MatchStateUnit { shared }
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        let Ok(frame) = frame else { continue };
        let Some(request) = said::<MatchSearchRequested>(&frame) else {
            continue;
        };
        let under = Envelope {
            correlation_id: frame.correlation_id,
            scope: None,
        };
        let searching = shared.clone();
        shared.tasks.spawn(async move {
            let reference_id = request.reference_id.clone();
            match searching.client.match_.search(request).await {
                Ok(found) => signal::<MatchSearchResults>(&searching.client, &found, under),
                Err(error) => signal::<MatchSearchFailed>(
                    &searching.client,
                    &types::MatchSearchFailed {
                        reference_id,
                        error: error.to_string(),
                    },
                    under,
                ),
            }
        });
    }
}

impl StateUnit for MatchStateUnit {
    fn dispose(&self) {
        self.shared.tasks.stop();
    }
}

impl Drop for MatchStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
