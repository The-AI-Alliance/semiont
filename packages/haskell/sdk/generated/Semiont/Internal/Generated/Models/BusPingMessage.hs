-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusPingMessage
  ( BusPingMessage(..)
  , BusPingMessageEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BusPingMessage = BusPingMessage { busPingMessageData :: Text, busPingMessageEvent :: BusPingMessageEvent } deriving (Eq, Show)
instance FromJSON BusPingMessage where
  parseJSON = checked "BusPingMessage" $ withObject "BusPingMessage" (\fields -> BusPingMessage <$> fields .: "data" <*> fields .: "event")
instance ToJSON BusPingMessage where toJSON value = Object (KM.fromList (concat [[("data", toJSON (busPingMessageData value))], [("event", toJSON (busPingMessageEvent value))]]))

data BusPingMessageEvent = BusPingMessageEventPing deriving (Eq, Show)
instance FromJSON BusPingMessageEvent where
  parseJSON = checked "BusPingMessageEvent" $ \value -> if value == (String "ping") then pure BusPingMessageEventPing else fail "unknown enumeration member"
instance ToJSON BusPingMessageEvent where
  toJSON BusPingMessageEventPing = String "ping"
