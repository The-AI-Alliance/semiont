-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherAnnotationOptions
  ( GatherAnnotationOptions(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data GatherAnnotationOptions = GatherAnnotationOptions { gatherAnnotationOptionsContextWindow :: Maybe (Integer), gatherAnnotationOptionsIncludeSourceContext :: Maybe (Bool), gatherAnnotationOptionsIncludeTargetContext :: Maybe (Bool), gatherAnnotationOptionsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherAnnotationOptions where
  parseJSON = checked "GatherAnnotationOptions" $ withObject "GatherAnnotationOptions" (\fields -> GatherAnnotationOptions <$> optional fields "contextWindow" <*> optional fields "includeSourceContext" <*> optional fields "includeTargetContext" <*> traverse parseJSON (withoutFields ["contextWindow", "includeSourceContext", "includeTargetContext"] fields))
instance ToJSON GatherAnnotationOptions where toJSON value = Object (KM.fromList (concat [optionalPair "contextWindow" (gatherAnnotationOptionsContextWindow value), optionalPair "includeSourceContext" (gatherAnnotationOptionsIncludeSourceContext value), optionalPair "includeTargetContext" (gatherAnnotationOptionsIncludeTargetContext value)]) <> fmap toJSON (withoutFields ["contextWindow", "includeSourceContext", "includeTargetContext"] (gatherAnnotationOptionsAdditionalProperties value)))
