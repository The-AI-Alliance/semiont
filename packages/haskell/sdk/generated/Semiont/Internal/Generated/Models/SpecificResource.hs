-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SpecificResource
  ( SpecificResource(..)
  , SpecificResourceType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.BodyPurpose
import Semiont.Internal.Generated.Models.ResourceId
data SpecificResource = SpecificResource { specificResourcePurpose :: Maybe (BodyPurpose), specificResourceSource :: ResourceId, specificResourceType :: SpecificResourceType, specificResourceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SpecificResource where
  parseJSON = checked "SpecificResource" $ withObject "SpecificResource" (\fields -> SpecificResource <$> optional fields "purpose" <*> fields .: "source" <*> fields .: "type" <*> traverse parseJSON (withoutFields ["purpose", "source", "type"] fields))
instance ToJSON SpecificResource where toJSON value = Object (KM.fromList (concat [optionalPair "purpose" (specificResourcePurpose value), [("source", toJSON (specificResourceSource value))], [("type", toJSON (specificResourceType value))]]) <> fmap toJSON (withoutFields ["purpose", "source", "type"] (specificResourceAdditionalProperties value)))

data SpecificResourceType = SpecificResourceTypeSpecificResource deriving (Eq, Show)
instance FromJSON SpecificResourceType where
  parseJSON = checked "SpecificResourceType" $ \value -> if value == (String "SpecificResource") then pure SpecificResourceTypeSpecificResource else fail "unknown enumeration member"
instance ToJSON SpecificResourceType where
  toJSON SpecificResourceTypeSpecificResource = String "SpecificResource"
