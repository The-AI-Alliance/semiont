-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceUpdatedPayload
  ( ResourceUpdatedPayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ResourceUpdatedPayload = ResourceUpdatedPayload { resourceUpdatedPayloadContentByteSize :: Maybe (Integer), resourceUpdatedPayloadContentChecksum :: Text, resourceUpdatedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceUpdatedPayload where
  parseJSON = checked "ResourceUpdatedPayload" $ withObject "ResourceUpdatedPayload" (\fields -> ResourceUpdatedPayload <$> optional fields "contentByteSize" <*> fields .: "contentChecksum" <*> traverse parseJSON (withoutFields ["contentByteSize", "contentChecksum"] fields))
instance ToJSON ResourceUpdatedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "contentByteSize" (resourceUpdatedPayloadContentByteSize value), [("contentChecksum", toJSON (resourceUpdatedPayloadContentChecksum value))]]) <> fmap toJSON (withoutFields ["contentByteSize", "contentChecksum"] (resourceUpdatedPayloadAdditionalProperties value)))
