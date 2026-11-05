-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchResourcesRequest
  ( MatchResourcesRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data MatchResourcesRequest = MatchResourcesRequest { matchResourcesRequestArchived :: Maybe (Bool), matchResourcesRequestEntityType :: Maybe (Text), matchResourcesRequestLimit :: Maybe (Integer), matchResourcesRequestOffset :: Maybe (Integer), matchResourcesRequestSearch :: Text, matchResourcesRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchResourcesRequest where
  parseJSON = checked "MatchResourcesRequest" $ withObject "MatchResourcesRequest" (\fields -> MatchResourcesRequest <$> optional fields "archived" <*> optional fields "entityType" <*> optional fields "limit" <*> optional fields "offset" <*> fields .: "search" <*> traverse parseJSON (withoutFields ["archived", "entityType", "limit", "offset", "search"] fields))
instance ToJSON MatchResourcesRequest where toJSON value = Object (KM.fromList (concat [optionalPair "archived" (matchResourcesRequestArchived value), optionalPair "entityType" (matchResourcesRequestEntityType value), optionalPair "limit" (matchResourcesRequestLimit value), optionalPair "offset" (matchResourcesRequestOffset value), [("search", toJSON (matchResourcesRequestSearch value))]]) <> fmap toJSON (withoutFields ["archived", "entityType", "limit", "offset", "search"] (matchResourcesRequestAdditionalProperties value)))
