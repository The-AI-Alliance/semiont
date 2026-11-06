-- Generated from session/session-signals.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.SessionNotices where
import Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import Data.Text (Text)
import Semiont.Internal.Generated.Stored (SessionEndReason)
data SessionEnded = SessionEnded { sessionEndedReason :: SessionEndReason } deriving (Eq, Show)
instance FromJSON SessionEnded where
  parseJSON = withObject "SessionEnded" (\fields -> SessionEnded <$> fields .: "reason")
instance ToJSON SessionEnded where
  toJSON value = object ["reason" .= sessionEndedReason value]
data PermissionDenied = PermissionDenied { permissionDeniedDetail :: Maybe Text } deriving (Eq, Show)
instance FromJSON PermissionDenied where
  parseJSON = withObject "PermissionDenied" (\fields -> PermissionDenied <$> fields .: "detail")
instance ToJSON PermissionDenied where
  toJSON value = object ["detail" .= permissionDeniedDetail value]
data KbIdentityConflict = KbIdentityConflict { kbIdentityConflictExpectedDid :: Text, kbIdentityConflictObservedDid :: Text } deriving (Eq, Show)
instance FromJSON KbIdentityConflict where
  parseJSON = withObject "KbIdentityConflict" (\fields -> KbIdentityConflict <$> fields .: "expectedDid" <*> fields .: "observedDid")
instance ToJSON KbIdentityConflict where
  toJSON value = object ["expectedDid" .= kbIdentityConflictExpectedDid value, "observedDid" .= kbIdentityConflictObservedDid value]
