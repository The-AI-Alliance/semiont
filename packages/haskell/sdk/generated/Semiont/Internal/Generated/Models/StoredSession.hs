-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.StoredSession
  ( StoredSession(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data StoredSession = StoredSession { storedSessionAccess :: Text, storedSessionClientId :: Text, storedSessionRefresh :: Text, storedSessionRevocationEndpoint :: Maybe (Text), storedSessionTokenEndpoint :: Text, storedSessionAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON StoredSession where
  parseJSON = checked "StoredSession" $ withObject "StoredSession" (\fields -> StoredSession <$> fields .: "access" <*> fields .: "clientId" <*> fields .: "refresh" <*> optional fields "revocationEndpoint" <*> fields .: "tokenEndpoint" <*> traverse parseJSON (withoutFields ["access", "clientId", "refresh", "revocationEndpoint", "tokenEndpoint"] fields))
instance ToJSON StoredSession where toJSON value = Object (KM.fromList (concat [[("access", toJSON (storedSessionAccess value))], [("clientId", toJSON (storedSessionClientId value))], [("refresh", toJSON (storedSessionRefresh value))], optionalPair "revocationEndpoint" (storedSessionRevocationEndpoint value), [("tokenEndpoint", toJSON (storedSessionTokenEndpoint value))]]) <> fmap toJSON (withoutFields ["access", "clientId", "refresh", "revocationEndpoint", "tokenEndpoint"] (storedSessionAdditionalProperties value)))
