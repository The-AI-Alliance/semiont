-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherResourceRequestOptions
  ( GatherResourceRequestOptions(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data GatherResourceRequestOptions = GatherResourceRequestOptions { gatherResourceRequestOptionsDepth :: Integer, gatherResourceRequestOptionsExcludeEntityTypes :: Maybe ([Text]), gatherResourceRequestOptionsIncludeContent :: Bool, gatherResourceRequestOptionsIncludeSummary :: Bool, gatherResourceRequestOptionsMaxResources :: Integer, gatherResourceRequestOptionsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherResourceRequestOptions where
  parseJSON = checked "GatherResourceRequestOptions" $ withObject "GatherResourceRequestOptions" (\fields -> GatherResourceRequestOptions <$> fields .: "depth" <*> optional fields "excludeEntityTypes" <*> fields .: "includeContent" <*> fields .: "includeSummary" <*> fields .: "maxResources" <*> traverse parseJSON (withoutFields ["depth", "excludeEntityTypes", "includeContent", "includeSummary", "maxResources"] fields))
instance ToJSON GatherResourceRequestOptions where toJSON value = Object (KM.fromList (concat [[("depth", toJSON (gatherResourceRequestOptionsDepth value))], optionalPair "excludeEntityTypes" (gatherResourceRequestOptionsExcludeEntityTypes value), [("includeContent", toJSON (gatherResourceRequestOptionsIncludeContent value))], [("includeSummary", toJSON (gatherResourceRequestOptionsIncludeSummary value))], [("maxResources", toJSON (gatherResourceRequestOptionsMaxResources value))]]) <> fmap toJSON (withoutFields ["depth", "excludeEntityTypes", "includeContent", "includeSummary", "maxResources"] (gatherResourceRequestOptionsAdditionalProperties value)))
