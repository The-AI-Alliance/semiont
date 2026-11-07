-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourcesRequest
  ( BrowseResourcesRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseResourcesRequest = BrowseResourcesRequest { browseResourcesRequestArchived :: Maybe (Bool), browseResourcesRequestEntityType :: Maybe (Text), browseResourcesRequestLimit :: Maybe (Integer), browseResourcesRequestOffset :: Maybe (Integer), browseResourcesRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourcesRequest where
  parseJSON = checked "BrowseResourcesRequest" $ withObject "BrowseResourcesRequest" (\fields -> BrowseResourcesRequest <$> optional fields "archived" <*> optional fields "entityType" <*> optional fields "limit" <*> optional fields "offset" <*> traverse parseJSON (withoutFields ["archived", "entityType", "limit", "offset"] fields))
instance ToJSON BrowseResourcesRequest where toJSON value = Object (KM.fromList (concat [optionalPair "archived" (browseResourcesRequestArchived value), optionalPair "entityType" (browseResourcesRequestEntityType value), optionalPair "limit" (browseResourcesRequestLimit value), optionalPair "offset" (browseResourcesRequestOffset value)]) <> fmap toJSON (withoutFields ["archived", "entityType", "limit", "offset"] (browseResourcesRequestAdditionalProperties value)))
