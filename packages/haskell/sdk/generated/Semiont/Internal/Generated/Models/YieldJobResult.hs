-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldJobResult
  ( YieldJobResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobDeclined
import Semiont.Internal.Generated.Models.YieldJobDone
data YieldJobResult = YieldJobResultBranch1 (YieldJobDone) | YieldJobResultBranch2 (JobDeclined) deriving (Eq, Show)
instance FromJSON YieldJobResult where
  parseJSON = checked "YieldJobResult" $ \value -> (YieldJobResultBranch1 <$> parseJSON value) <|> (YieldJobResultBranch2 <$> parseJSON value)
instance ToJSON YieldJobResult where
  toJSON (YieldJobResultBranch1 value) = toJSON value
  toJSON (YieldJobResultBranch2 value) = toJSON value


