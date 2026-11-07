-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCompleteCommand
  ( JobCompleteCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MarkJobCompleteCommand
import Semiont.Internal.Generated.Models.YieldJobCompleteCommand
data JobCompleteCommand = JobCompleteCommandBranch1 (MarkJobCompleteCommand) | JobCompleteCommandBranch2 (YieldJobCompleteCommand) deriving (Eq, Show)
instance FromJSON JobCompleteCommand where
  parseJSON = checked "JobCompleteCommand" $ \value -> (JobCompleteCommandBranch1 <$> parseJSON value) <|> (JobCompleteCommandBranch2 <$> parseJSON value)
instance ToJSON JobCompleteCommand where
  toJSON (JobCompleteCommandBranch1 value) = toJSON value
  toJSON (JobCompleteCommandBranch2 value) = toJSON value
