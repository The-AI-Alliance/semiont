//! One open resource of a knowledge base (a tab, where there are tabs), and
//! what is a function of a list of them and nothing else: their order, and
//! what checking them against their knowledge base keeps and drops.

use crate::types::ResourceId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResource {
    pub id: ResourceId,
    pub name: String,
    /// When it was opened, in milliseconds since the epoch.
    pub opened_at: u64,
    /// Its place among the others.
    pub order: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// Where it is in the working tree, such as `file://docs/overview.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_uri: Option<String>,
}

/// What checking one open resource against its knowledge base concluded.
///
/// `Gone` is the only verdict that removes, and it means the knowledge base
/// said the resource does not exist, not that the check failed. A transport
/// failure, a timeout and a peer that is down are all `Unknown`, and an
/// unknown resource stays open: closing everything because a service was
/// briefly down would be worse than the stale entries this removes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabCheck {
    Gone,
    Ready {
        name: String,
        media_type: Option<String>,
    },
    Unknown,
}

/// Apply each verdict to `list`: drop what is gone, take the name and media
/// type of what was found, and leave everything else as it was. One with no
/// verdict is left: it was opened while the checks were in flight.
pub fn apply_tab_checks(
    list: Vec<OpenResource>,
    checks: &HashMap<ResourceId, TabCheck>,
) -> Vec<OpenResource> {
    list.into_iter()
        .filter_map(|tab| match checks.get(&tab.id) {
            Some(TabCheck::Gone) => None,
            Some(TabCheck::Ready { name, media_type }) => Some(OpenResource {
                name: name.clone(),
                media_type: media_type.clone().or(tab.media_type.clone()),
                ..tab
            }),
            Some(TabCheck::Unknown) | None => Some(tab),
        })
        .collect()
}

/// By the place each has, and among those given the same place, by when
/// each was opened.
pub fn sort_open_resources(mut resources: Vec<OpenResource>) -> Vec<OpenResource> {
    resources.sort_by_key(|resource| (resource.order, resource.opened_at));
    resources
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(text: &str) -> ResourceId {
        text.parse().expect("a test names an id")
    }

    fn tab(named: &str, opened_at: u64, order: u64) -> OpenResource {
        OpenResource {
            id: id(named),
            name: format!("name of {named}"),
            opened_at,
            order,
            media_type: Some("text/plain".to_owned()),
            storage_uri: None,
        }
    }

    fn ids(list: &[OpenResource]) -> Vec<&str> {
        list.iter().map(|tab| tab.id.as_str()).collect()
    }

    #[test]
    fn they_are_ordered_by_place_and_then_by_when_they_were_opened() {
        let sorted = sort_open_resources(vec![
            tab("b", 20, 1),
            tab("a", 30, 0),
            tab("d", 15, 1),
            tab("c", 10, 2),
        ]);
        assert_eq!(ids(&sorted), ["a", "d", "b", "c"]);
    }

    #[test]
    fn only_a_resource_the_knowledge_base_says_is_gone_is_dropped() {
        let checks = HashMap::from([
            (id("gone"), TabCheck::Gone),
            (
                id("found"),
                TabCheck::Ready {
                    name: "Its name now".to_owned(),
                    media_type: None,
                },
            ),
            (id("unknown"), TabCheck::Unknown),
        ]);
        let kept = apply_tab_checks(
            vec![
                tab("gone", 1, 0),
                tab("found", 2, 1),
                tab("unknown", 3, 2),
                tab("opened-meanwhile", 4, 3),
            ],
            &checks,
        );
        assert_eq!(ids(&kept), ["found", "unknown", "opened-meanwhile"]);
        assert_eq!(kept[0].name, "Its name now");
        // A check that states no media type leaves the one it had.
        assert_eq!(kept[0].media_type.as_deref(), Some("text/plain"));
        assert_eq!(kept[1].name, "name of unknown");
    }
}
