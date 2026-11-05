-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseEventsRequest
  ( BrowseEventsRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data BrowseEventsRequest = BrowseEventsRequest { browseEventsRequestLimit :: Maybe (Integer), browseEventsRequestResourceId :: ResourceId, browseEventsRequestType :: Maybe (Text), browseEventsRequestUserId :: Maybe (UserId), browseEventsRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseEventsRequest where
  parseJSON = checked "BrowseEventsRequest" $ withObject "BrowseEventsRequest" (\fields -> BrowseEventsRequest <$> optional fields "limit" <*> fields .: "resourceId" <*> optional fields "type" <*> optional fields "userId" <*> traverse parseJSON (withoutFields ["limit", "resourceId", "type", "userId"] fields))
instance ToJSON BrowseEventsRequest where toJSON value = Object (KM.fromList (concat [optionalPair "limit" (browseEventsRequestLimit value), [("resourceId", toJSON (browseEventsRequestResourceId value))], optionalPair "type" (browseEventsRequestType value), optionalPair "userId" (browseEventsRequestUserId value)]) <> fmap toJSON (withoutFields ["limit", "resourceId", "type", "userId"] (browseEventsRequestAdditionalProperties value)))

