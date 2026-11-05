-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ReplyEventId
  ( ReplyEventId(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype ReplyEventId = ReplyEventId { replyEventIdValue :: Text } deriving (Eq, Show)
instance FromJSON ReplyEventId where
  parseJSON = checked "ReplyEventId" $ \value -> ReplyEventId <$> parseJSON value
instance ToJSON ReplyEventId where toJSON (ReplyEventId value) = toJSON value

