//! A pointer's dwell: an annotation is hovered once the pointer has rested
//! on it, and no longer the moment it leaves. A pointer crossing the page
//! hovers nothing on its way.

use crate::locked;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::AbortHandle;

#[derive(Default)]
struct Dwell {
    /// What was last said to be hovered.
    hovering: Option<String>,
    /// The rest that has not run its time yet.
    resting: Option<AbortHandle>,
    /// Which rest is the current one: one that was overtaken says nothing.
    rest: u64,
}

impl Dwell {
    fn interrupt(&mut self) {
        self.rest += 1;
        if let Some(resting) = self.resting.take() {
            resting.abort();
        }
    }
}

type Say = dyn Fn(Option<&str>) + Send + Sync;

/// See the module's documentation. `say` is told each change: the
/// annotation hovered, or none. `client.beckon.hover` is what it is usually
/// given. Dropping it forgets a rest that has not run its time.
pub struct HoverDwell {
    dwell: Arc<Mutex<Dwell>>,
    say: Arc<Say>,
    delay: Duration,
}

impl HoverDwell {
    /// A dwell of `delay`: `crate::timing::HOVER_DELAY` unless the viewer
    /// was told another.
    pub fn new(say: impl Fn(Option<&str>) + Send + Sync + 'static, delay: Duration) -> HoverDwell {
        HoverDwell {
            dwell: Arc::new(Mutex::new(Dwell::default())),
            say: Arc::new(say),
            delay,
        }
    }

    /// The pointer is on an annotation. It is hovered once the pointer has
    /// stayed for the delay; one already hovered is not said again.
    pub fn enter(&self, annotation_id: &str) {
        let mut dwell = locked(&self.dwell);
        if dwell.hovering.as_deref() == Some(annotation_id) {
            return;
        }
        dwell.interrupt();
        let (rest, delay) = (dwell.rest, self.delay);
        let (shared, say) = (self.dwell.clone(), self.say.clone());
        let annotation_id = annotation_id.to_owned();
        let resting = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut dwell = locked(&shared);
                if dwell.rest != rest {
                    return;
                }
                dwell.resting = None;
                dwell.hovering = Some(annotation_id.clone());
            }
            say(Some(&annotation_id));
        });
        dwell.resting = Some(resting.abort_handle());
    }

    /// The pointer left. Said at once, and only when something was hovered.
    pub fn leave(&self) {
        let was_hovering = {
            let mut dwell = locked(&self.dwell);
            dwell.interrupt();
            dwell.hovering.take().is_some()
        };
        if was_hovering {
            (self.say)(None);
        }
    }
}

impl Drop for HoverDwell {
    fn drop(&mut self) {
        locked(&self.dwell).interrupt();
    }
}
