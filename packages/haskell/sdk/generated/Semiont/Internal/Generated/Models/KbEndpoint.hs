-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbEndpoint
  ( KbEndpoint(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.HttpEndpoint
import Semiont.Internal.Generated.Models.LocalEndpoint
data KbEndpoint = KbEndpointBranch1 (HttpEndpoint) | KbEndpointBranch2 (LocalEndpoint) deriving (Eq, Show)
instance FromJSON KbEndpoint where
  parseJSON = checked "KbEndpoint" $ \value -> (KbEndpointBranch1 <$> parseJSON value) <|> (KbEndpointBranch2 <$> parseJSON value)
instance ToJSON KbEndpoint where
  toJSON (KbEndpointBranch1 value) = toJSON value
  toJSON (KbEndpointBranch2 value) = toJSON value
