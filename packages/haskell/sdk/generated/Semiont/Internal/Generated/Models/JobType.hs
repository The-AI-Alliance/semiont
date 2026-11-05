-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobType
  ( JobType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobType = JobTypeMark | JobTypeYield deriving (Eq, Show)
instance FromJSON JobType where
  parseJSON = checked "JobType" $ \value -> if value == (String "mark") then pure JobTypeMark else if value == (String "yield") then pure JobTypeYield else fail "unknown enumeration member"
instance ToJSON JobType where
  toJSON JobTypeMark = String "mark"
  toJSON JobTypeYield = String "yield"


