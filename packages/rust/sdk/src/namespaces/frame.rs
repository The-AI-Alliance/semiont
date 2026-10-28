//! Frame: the knowledge base's vocabulary. Each write is confirmed: it
//! resolves when the knowledge base says it is recorded, and fails with the
//! failure it answered.

use crate::channels::{FrameAddEntityType, FrameAddTagSchema};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::types::{FrameAddEntityTypeCommand, FrameAddTagSchemaCommand, TagSchema};

pub struct FrameNamespace {
    links: Links,
}

impl FrameNamespace {
    pub(crate) fn new(links: Links) -> FrameNamespace {
        FrameNamespace { links }
    }

    /// Add one entity type. Adding one that is there already changes nothing.
    pub async fn add_entity_type(&self, entity_type: &str) -> Result<(), SemiontError> {
        self.links
            .request::<FrameAddEntityType>(&FrameAddEntityTypeCommand {
                tag: entity_type.to_owned(),
                _user_id: None,
            })
            .await?;
        Ok(())
    }

    /// Add several, one request each, in order; the first that fails ends it.
    pub async fn add_entity_types(&self, entity_types: &[String]) -> Result<(), SemiontError> {
        for entity_type in entity_types {
            self.add_entity_type(entity_type).await?;
        }
        Ok(())
    }

    /// Register a tag schema. The last registration under an id is the one
    /// that stands.
    pub async fn add_tag_schema(&self, schema: TagSchema) -> Result<(), SemiontError> {
        self.links
            .request::<FrameAddTagSchema>(&FrameAddTagSchemaCommand {
                schema,
                _user_id: None,
            })
            .await?;
        Ok(())
    }
}
