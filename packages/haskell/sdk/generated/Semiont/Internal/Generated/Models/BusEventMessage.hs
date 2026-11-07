-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusEventMessage
  ( BusEventMessage(..)
  , BusEventMessageEvent(..)
  , BusEventMessageId(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.BusFrame
import Semiont.Internal.Generated.Models.EphemeralEventId
import Semiont.Internal.Generated.Models.PersistedEventId
import Semiont.Internal.Generated.Models.ReplyEventId
data BusEventMessage = BusEventMessage { busEventMessageData :: BusFrame, busEventMessageEvent :: BusEventMessageEvent, busEventMessageId :: BusEventMessageId } deriving (Eq, Show)
instance FromJSON BusEventMessage where
  parseJSON = checked "BusEventMessage" $ withObject "BusEventMessage" (\fields -> BusEventMessage <$> fields .: "data" <*> fields .: "event" <*> fields .: "id")
instance ToJSON BusEventMessage where toJSON value = Object (KM.fromList (concat [[("data", toJSON (busEventMessageData value))], [("event", toJSON (busEventMessageEvent value))], [("id", toJSON (busEventMessageId value))]]))

data BusEventMessageEvent = BusEventMessageEventBusU2d_event deriving (Eq, Show)
instance FromJSON BusEventMessageEvent where
  parseJSON = checked "BusEventMessageEvent" $ \value -> if value == (String "bus-event") then pure BusEventMessageEventBusU2d_event else fail "unknown enumeration member"
instance ToJSON BusEventMessageEvent where
  toJSON BusEventMessageEventBusU2d_event = String "bus-event"


data BusEventMessageId = BusEventMessageIdBranch1 (PersistedEventId) | BusEventMessageIdBranch2 (ReplyEventId) | BusEventMessageIdBranch3 (EphemeralEventId) deriving (Eq, Show)
instance FromJSON BusEventMessageId where
  parseJSON = checked "BusEventMessageId" $ \value -> (BusEventMessageIdBranch1 <$> parseJSON value) <|> (BusEventMessageIdBranch2 <$> parseJSON value) <|> (BusEventMessageIdBranch3 <$> parseJSON value)
instance ToJSON BusEventMessageId where
  toJSON (BusEventMessageIdBranch1 value) = toJSON value
  toJSON (BusEventMessageIdBranch2 value) = toJSON value
  toJSON (BusEventMessageIdBranch3 value) = toJSON value
