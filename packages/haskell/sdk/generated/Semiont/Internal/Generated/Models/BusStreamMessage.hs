-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusStreamMessage
  ( BusStreamMessage(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.BusEventMessage
import Semiont.Internal.Generated.Models.BusPingMessage
data BusStreamMessage = BusStreamMessageBranch1 (BusEventMessage) | BusStreamMessageBranch2 (BusPingMessage) deriving (Eq, Show)
instance FromJSON BusStreamMessage where
  parseJSON = checked "BusStreamMessage" $ \value -> (BusStreamMessageBranch1 <$> parseJSON value) <|> (BusStreamMessageBranch2 <$> parseJSON value)
instance ToJSON BusStreamMessage where
  toJSON (BusStreamMessageBranch1 value) = toJSON value
  toJSON (BusStreamMessageBranch2 value) = toJSON value
