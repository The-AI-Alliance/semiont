-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SignedIn
  ( SignedIn(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbDescription
import Semiont.Internal.Generated.Models.KbEndpoint
import Semiont.Internal.Generated.Models.StoredSession
data SignedIn = SignedIn { signedInDescription :: KbDescription, signedInEndpoint :: KbEndpoint, signedInExpectedDid :: Maybe (Text), signedInExpectedName :: Maybe (Text), signedInKbId :: Maybe (Text), signedInSession :: StoredSession, signedInAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SignedIn where
  parseJSON = checked "SignedIn" $ withObject "SignedIn" (\fields -> SignedIn <$> fields .: "description" <*> fields .: "endpoint" <*> optional fields "expectedDid" <*> optional fields "expectedName" <*> optional fields "kbId" <*> fields .: "session" <*> traverse parseJSON (withoutFields ["description", "endpoint", "expectedDid", "expectedName", "kbId", "session"] fields))
instance ToJSON SignedIn where toJSON value = Object (KM.fromList (concat [[("description", toJSON (signedInDescription value))], [("endpoint", toJSON (signedInEndpoint value))], optionalPair "expectedDid" (signedInExpectedDid value), optionalPair "expectedName" (signedInExpectedName value), optionalPair "kbId" (signedInKbId value), [("session", toJSON (signedInSession value))]]) <> fmap toJSON (withoutFields ["description", "endpoint", "expectedDid", "expectedName", "kbId", "session"] (signedInAdditionalProperties value)))
