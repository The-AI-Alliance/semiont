//! The one composition of plane and ledger: the ledger over the plane's
//! shared tables, and its standing tap — one subscription over every
//! correlated channel for the life of the gateway, so a reply is observed
//! (answered, retained) even while its client is between connections — and
//! the count of streams each principal holds, in a table of its own.

use crate::ledger::Ledger;
use crate::signal::{ClientSubscription, SignalPlane, Subscription};
use crate::stream_counts::StreamCounts;
use semiont_core::spec::spec;
use std::sync::Arc;

pub struct Composition {
    pub plane: Arc<dyn SignalPlane>,
    pub ledger: Arc<Ledger>,
    pub streams: Arc<StreamCounts>,
    _tap: Subscription,
}

pub async fn compose(plane: Arc<dyn SignalPlane>) -> Result<Composition, String> {
    let ledger = Ledger::open(plane.as_ref()).await?;
    let streams = StreamCounts::open(plane.as_ref()).await?;
    let observer = ledger.clone();
    let tap = plane
        .subscribe_client(ClientSubscription {
            global: spec().correlated_channels(),
            scoped: Vec::new(),
            on_frame: Arc::new(move |frame| {
                observer.observe(&frame.channel, &frame.payload, frame.meta.as_ref())
            }),
        })
        .await?;
    Ok(Composition {
        plane,
        ledger,
        streams,
        _tap: tap,
    })
}
