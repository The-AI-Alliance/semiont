-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobQueuedEvent
  ( JobQueuedEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MarkJobQueuedEvent
import Semiont.Internal.Generated.Models.YieldJobQueuedEvent
data JobQueuedEvent = JobQueuedEventBranch1 (MarkJobQueuedEvent) | JobQueuedEventBranch2 (YieldJobQueuedEvent) deriving (Eq, Show)
instance FromJSON JobQueuedEvent where
  parseJSON = checked "JobQueuedEvent" $ \value -> (JobQueuedEventBranch1 <$> parseJSON value) <|> (JobQueuedEventBranch2 <$> parseJSON value)
instance ToJSON JobQueuedEvent where
  toJSON (JobQueuedEventBranch1 value) = toJSON value
  toJSON (JobQueuedEventBranch2 value) = toJSON value
