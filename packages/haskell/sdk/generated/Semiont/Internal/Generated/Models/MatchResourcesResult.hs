-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchResourcesResult
  ( MatchResourcesResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MatchResourcesResponse
data MatchResourcesResult = MatchResourcesResult { matchResourcesResultResponse :: MatchResourcesResponse, matchResourcesResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchResourcesResult where
  parseJSON = checked "MatchResourcesResult" $ withObject "MatchResourcesResult" (\fields -> MatchResourcesResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON MatchResourcesResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (matchResourcesResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (matchResourcesResultAdditionalProperties value)))
