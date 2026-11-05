-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationTarget
  ( AnnotationTarget(..)
  , AnnotationTargetType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationSelector
import Semiont.Internal.Generated.Models.ResourceId
data AnnotationTarget = AnnotationTarget { annotationTargetSelector :: Maybe (AnnotationSelector), annotationTargetSource :: ResourceId, annotationTargetType :: Maybe (AnnotationTargetType), annotationTargetAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnnotationTarget where
  parseJSON = checked "AnnotationTarget" $ withObject "AnnotationTarget" (\fields -> AnnotationTarget <$> optional fields "selector" <*> fields .: "source" <*> optional fields "type" <*> traverse parseJSON (withoutFields ["selector", "source", "type"] fields))
instance ToJSON AnnotationTarget where toJSON value = Object (KM.fromList (concat [optionalPair "selector" (annotationTargetSelector value), [("source", toJSON (annotationTargetSource value))], optionalPair "type" (annotationTargetType value)]) <> fmap toJSON (withoutFields ["selector", "source", "type"] (annotationTargetAdditionalProperties value)))

data AnnotationTargetType = AnnotationTargetTypeSpecificResource deriving (Eq, Show)
instance FromJSON AnnotationTargetType where
  parseJSON = checked "AnnotationTargetType" $ \value -> if value == (String "SpecificResource") then pure AnnotationTargetTypeSpecificResource else fail "unknown enumeration member"
instance ToJSON AnnotationTargetType where
  toJSON AnnotationTargetTypeSpecificResource = String "SpecificResource"


