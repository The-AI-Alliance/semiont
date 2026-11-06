-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ConnectionIdentity
  ( ConnectionIdentity(..)
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
import Semiont.Internal.Generated.Models.UserId
data ConnectionIdentity = ConnectionIdentity { connectionIdentityDescription :: KbDescription, connectionIdentityDid :: UserId, connectionIdentityAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ConnectionIdentity where
  parseJSON = checked "ConnectionIdentity" $ withObject "ConnectionIdentity" (\fields -> ConnectionIdentity <$> fields .: "description" <*> fields .: "did" <*> traverse parseJSON (withoutFields ["description", "did"] fields))
instance ToJSON ConnectionIdentity where toJSON value = Object (KM.fromList (concat [[("description", toJSON (connectionIdentityDescription value))], [("did", toJSON (connectionIdentityDid value))]]) <> fmap toJSON (withoutFields ["description", "did"] (connectionIdentityAdditionalProperties value)))
