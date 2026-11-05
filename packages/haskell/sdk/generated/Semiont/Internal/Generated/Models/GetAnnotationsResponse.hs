-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetAnnotationsResponse
  ( GetAnnotationsResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
import Semiont.Internal.Generated.Models.Motivation
data GetAnnotationsResponse = GetAnnotationsResponse { getAnnotationsResponseAnnotations :: [Annotation], getAnnotationsResponseMotivation :: Presence (Motivation), getAnnotationsResponseTotal :: Scientific, getAnnotationsResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetAnnotationsResponse where
  parseJSON = checked "GetAnnotationsResponse" $ withObject "GetAnnotationsResponse" (\fields -> GetAnnotationsResponse <$> fields .: "annotations" <*> presence fields "motivation" <*> fields .: "total" <*> traverse parseJSON (withoutFields ["annotations", "motivation", "total"] fields))
instance ToJSON GetAnnotationsResponse where toJSON value = Object (KM.fromList (concat [[("annotations", toJSON (getAnnotationsResponseAnnotations value))], presencePair "motivation" (getAnnotationsResponseMotivation value), [("total", toJSON (getAnnotationsResponseTotal value))]]) <> fmap toJSON (withoutFields ["annotations", "motivation", "total"] (getAnnotationsResponseAdditionalProperties value)))

