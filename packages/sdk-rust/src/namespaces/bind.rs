//! Bind: linking a reference to what it refers to.

use crate::channels::{BindBodyError, BindInitiate, BindUpdateBody};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::transport::Envelope;
use crate::types::{
    BindBodyOperation, BindInitiateCommand, BindUpdateBodyCommand, ResourceErrorEvent,
};

pub struct BindNamespace {
    links: Links,
}

impl BindNamespace {
    pub(crate) fn new(links: Links) -> BindNamespace {
        BindNamespace { links }
    }

    /// Change an annotation's body. Confirmed: it resolves when the change is
    /// recorded, and fails with the failure the knowledge base answered.
    pub async fn body(
        &self,
        resource_id: &str,
        annotation_id: &str,
        operations: Vec<BindBodyOperation>,
    ) -> Result<(), SemiontError> {
        self.links
            .request::<BindUpdateBody>(&BindUpdateBodyCommand {
                _user_id: None,
                annotation_id: annotation_id.to_owned(),
                resource_id: resource_id.to_owned(),
                operations,
            })
            .await?;
        Ok(())
    }

    /// Signal: a binding is wanted for an annotation.
    pub fn initiate(&self, input: BindInitiateCommand) {
        self.links
            .signal::<BindInitiate>(&input, Envelope::default());
    }

    /// Signal: a body update failed where nothing could show it.
    pub fn report_body_error(&self, input: ResourceErrorEvent) {
        self.links
            .signal::<BindBodyError>(&input, Envelope::default());
    }
}
