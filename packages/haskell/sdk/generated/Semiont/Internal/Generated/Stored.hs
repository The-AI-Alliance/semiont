-- Generated from session/stored.json and session/cases.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.Stored where
import Data.Text (Text)
import Data.Aeson (FromJSON(..), ToJSON(..), Value(String), withText)
knowledgeBasesKey :: Text
knowledgeBasesKey = "semiont.knowledgeBases"
activeKey :: Text
activeKey = "semiont.activeKnowledgeBaseId"
openResourcesByKbKey :: Text
openResourcesByKbKey = "semiont.openResourcesByKb"
lastViewedResourceByKbKey :: Text
lastViewedResourceByKbKey = "semiont.lastViewedResourceByKb"
pendingAuthorizationKey :: Text
pendingAuthorizationKey = "semiont.pendingAuthorization"
sessionKeyPrefix :: Text
sessionKeyPrefix = "semiont.session."
lastEventIdKeyPrefix :: Text
lastEventIdKeyPrefix = "semiont.lastEventId."
cacheKeyPrefix :: Text
cacheKeyPrefix = "semiont.cache."
data SessionEndReason = Expired | Refused deriving (Eq, Ord, Show, Enum, Bounded)
sessionEndReason :: SessionEndReason -> Text
sessionEndReason Expired = "expired"
sessionEndReason Refused = "refused"
instance ToJSON SessionEndReason where toJSON = String . sessionEndReason
instance FromJSON SessionEndReason where
  parseJSON = withText "SessionEndReason" $ \value -> case value of
    "expired" -> pure Expired
    "refused" -> pure Refused
    _ -> fail "unknown session end reason"
