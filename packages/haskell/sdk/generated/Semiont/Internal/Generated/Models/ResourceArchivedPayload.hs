-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceArchivedPayload
  ( ResourceArchivedPayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ResourceArchivedPayload = ResourceArchivedPayload { resourceArchivedPayloadReason :: Maybe (Text), resourceArchivedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceArchivedPayload where
  parseJSON = checked "ResourceArchivedPayload" $ withObject "ResourceArchivedPayload" (\fields -> ResourceArchivedPayload <$> optional fields "reason" <*> traverse parseJSON (withoutFields ["reason"] fields))
instance ToJSON ResourceArchivedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "reason" (resourceArchivedPayloadReason value)]) <> fmap toJSON (withoutFields ["reason"] (resourceArchivedPayloadAdditionalProperties value)))
