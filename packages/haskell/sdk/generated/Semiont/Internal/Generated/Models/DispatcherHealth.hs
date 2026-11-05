-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DispatcherHealth
  ( DispatcherHealth(..)
  , DispatcherHealthQueue(..)
  , DispatcherHealthStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data DispatcherHealth = DispatcherHealth { dispatcherHealthQueue :: DispatcherHealthQueue, dispatcherHealthStatus :: DispatcherHealthStatus } deriving (Eq, Show)
instance FromJSON DispatcherHealth where
  parseJSON = checked "DispatcherHealth" $ withObject "DispatcherHealth" (\fields -> DispatcherHealth <$> fields .: "queue" <*> fields .: "status")
instance ToJSON DispatcherHealth where toJSON value = Object (KM.fromList (concat [[("queue", toJSON (dispatcherHealthQueue value))], [("status", toJSON (dispatcherHealthStatus value))]]))

data DispatcherHealthQueue = DispatcherHealthQueueJetstream deriving (Eq, Show)
instance FromJSON DispatcherHealthQueue where
  parseJSON = checked "DispatcherHealthQueue" $ \value -> if value == (String "jetstream") then pure DispatcherHealthQueueJetstream else fail "unknown enumeration member"
instance ToJSON DispatcherHealthQueue where
  toJSON DispatcherHealthQueueJetstream = String "jetstream"


data DispatcherHealthStatus = DispatcherHealthStatusOk deriving (Eq, Show)
instance FromJSON DispatcherHealthStatus where
  parseJSON = checked "DispatcherHealthStatus" $ \value -> if value == (String "ok") then pure DispatcherHealthStatusOk else fail "unknown enumeration member"
instance ToJSON DispatcherHealthStatus where
  toJSON DispatcherHealthStatusOk = String "ok"
