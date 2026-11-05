-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BeckonHoverEvent
  ( BeckonHoverEvent(..)
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
data BeckonHoverEvent = BeckonHoverEvent { beckonHoverEventAnnotationId :: Maybe (AnnotationId), beckonHoverEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BeckonHoverEvent where
  parseJSON = checked "BeckonHoverEvent" $ withObject "BeckonHoverEvent" (\fields -> BeckonHoverEvent <$> fields .: "annotationId" <*> traverse parseJSON (withoutFields ["annotationId"] fields))
instance ToJSON BeckonHoverEvent where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (beckonHoverEventAnnotationId value))]]) <> fmap toJSON (withoutFields ["annotationId"] (beckonHoverEventAdditionalProperties value)))

