-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CloneResourceWithTokenResponse
  ( CloneResourceWithTokenResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceDescriptor
data CloneResourceWithTokenResponse = CloneResourceWithTokenResponse { cloneResourceWithTokenResponseExpiresAt :: Text, cloneResourceWithTokenResponseResource :: ResourceDescriptor, cloneResourceWithTokenResponseToken :: Text, cloneResourceWithTokenResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON CloneResourceWithTokenResponse where
  parseJSON = checked "CloneResourceWithTokenResponse" $ withObject "CloneResourceWithTokenResponse" (\fields -> CloneResourceWithTokenResponse <$> fields .: "expiresAt" <*> fields .: "resource" <*> fields .: "token" <*> traverse parseJSON (withoutFields ["expiresAt", "resource", "token"] fields))
instance ToJSON CloneResourceWithTokenResponse where toJSON value = Object (KM.fromList (concat [[("expiresAt", toJSON (cloneResourceWithTokenResponseExpiresAt value))], [("resource", toJSON (cloneResourceWithTokenResponseResource value))], [("token", toJSON (cloneResourceWithTokenResponseToken value))]]) <> fmap toJSON (withoutFields ["expiresAt", "resource", "token"] (cloneResourceWithTokenResponseAdditionalProperties value)))
