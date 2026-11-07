-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherResourceOptions
  ( GatherResourceOptions(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data GatherResourceOptions = GatherResourceOptions { gatherResourceOptionsDepth :: Maybe (Integer), gatherResourceOptionsExcludeEntityTypes :: Maybe ([Text]), gatherResourceOptionsIncludeContent :: Maybe (Bool), gatherResourceOptionsIncludeSummary :: Maybe (Bool), gatherResourceOptionsMaxResources :: Maybe (Integer), gatherResourceOptionsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherResourceOptions where
  parseJSON = checked "GatherResourceOptions" $ withObject "GatherResourceOptions" (\fields -> GatherResourceOptions <$> optional fields "depth" <*> optional fields "excludeEntityTypes" <*> optional fields "includeContent" <*> optional fields "includeSummary" <*> optional fields "maxResources" <*> traverse parseJSON (withoutFields ["depth", "excludeEntityTypes", "includeContent", "includeSummary", "maxResources"] fields))
instance ToJSON GatherResourceOptions where toJSON value = Object (KM.fromList (concat [optionalPair "depth" (gatherResourceOptionsDepth value), optionalPair "excludeEntityTypes" (gatherResourceOptionsExcludeEntityTypes value), optionalPair "includeContent" (gatherResourceOptionsIncludeContent value), optionalPair "includeSummary" (gatherResourceOptionsIncludeSummary value), optionalPair "maxResources" (gatherResourceOptionsMaxResources value)]) <> fmap toJSON (withoutFields ["depth", "excludeEntityTypes", "includeContent", "includeSummary", "maxResources"] (gatherResourceOptionsAdditionalProperties value)))
