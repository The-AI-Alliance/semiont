-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BeckonFocusEvent
  ( BeckonFocusEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.ResourceId
data BeckonFocusEvent = BeckonFocusEvent { beckonFocusEventAnnotationId :: Maybe (AnnotationId), beckonFocusEventResourceId :: ResourceId, beckonFocusEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BeckonFocusEvent where
  parseJSON = checked "BeckonFocusEvent" $ withObject "BeckonFocusEvent" (\fields -> BeckonFocusEvent <$> optional fields "annotationId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON BeckonFocusEvent where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (beckonFocusEventAnnotationId value), [("resourceId", toJSON (beckonFocusEventResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (beckonFocusEventAdditionalProperties value)))
