-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCreateCommand
  ( JobCreateCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MarkJobCreateCommand
import Semiont.Internal.Generated.Models.YieldJobCreateCommand
data JobCreateCommand = JobCreateCommandBranch1 (MarkJobCreateCommand) | JobCreateCommandBranch2 (YieldJobCreateCommand) deriving (Eq, Show)
instance FromJSON JobCreateCommand where
  parseJSON = checked "JobCreateCommand" $ \value -> (JobCreateCommandBranch1 <$> parseJSON value) <|> (JobCreateCommandBranch2 <$> parseJSON value)
instance ToJSON JobCreateCommand where
  toJSON (JobCreateCommandBranch1 value) = toJSON value
  toJSON (JobCreateCommandBranch2 value) = toJSON value
