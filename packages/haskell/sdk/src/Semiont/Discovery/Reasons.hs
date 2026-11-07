-- Generated from protocol/specs/src/client/discovery-absent.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Discovery.Reasons (DiscoveryAbsentCode(..), discoveryAbsentCode, parseDiscoveryAbsentCode) where
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withText)
import Data.Text (Text)
data DiscoveryAbsentCode = DiscoveryAbsentNotFound | DiscoveryAbsentNotJson | DiscoveryAbsentInvalid | DiscoveryAbsentUnsupportedVersion | DiscoveryAbsentUnreadable deriving (Eq, Ord, Show, Enum, Bounded)
discoveryAbsentCode :: DiscoveryAbsentCode -> Text
discoveryAbsentCode DiscoveryAbsentNotFound = "not-found"
discoveryAbsentCode DiscoveryAbsentNotJson = "not-json"
discoveryAbsentCode DiscoveryAbsentInvalid = "invalid"
discoveryAbsentCode DiscoveryAbsentUnsupportedVersion = "unsupported-version"
discoveryAbsentCode DiscoveryAbsentUnreadable = "unreadable"
parseDiscoveryAbsentCode :: Text -> Maybe DiscoveryAbsentCode
parseDiscoveryAbsentCode value = case value of
  "not-found" -> Just DiscoveryAbsentNotFound
  "not-json" -> Just DiscoveryAbsentNotJson
  "invalid" -> Just DiscoveryAbsentInvalid
  "unsupported-version" -> Just DiscoveryAbsentUnsupportedVersion
  "unreadable" -> Just DiscoveryAbsentUnreadable
  _ -> Nothing
instance ToJSON DiscoveryAbsentCode where toJSON = String . discoveryAbsentCode
instance FromJSON DiscoveryAbsentCode where parseJSON = withText "DiscoveryAbsentCode" (\value -> maybe (fail "unknown error code") pure (parseDiscoveryAbsentCode value))
