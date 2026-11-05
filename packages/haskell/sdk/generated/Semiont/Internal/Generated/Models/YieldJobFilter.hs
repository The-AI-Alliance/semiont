-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldJobFilter
  ( YieldJobFilter(..)
  , YieldJobFilterJobType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data YieldJobFilter = YieldJobFilter { yieldJobFilterJobType :: YieldJobFilterJobType } deriving (Eq, Show)
instance FromJSON YieldJobFilter where
  parseJSON = checked "YieldJobFilter" $ withObject "YieldJobFilter" (\fields -> YieldJobFilter <$> fields .: "jobType")
instance ToJSON YieldJobFilter where toJSON value = Object (KM.fromList (concat [[("jobType", toJSON (yieldJobFilterJobType value))]]))

data YieldJobFilterJobType = YieldJobFilterJobTypeYield deriving (Eq, Show)
instance FromJSON YieldJobFilterJobType where
  parseJSON = checked "YieldJobFilterJobType" $ \value -> if value == (String "yield") then pure YieldJobFilterJobTypeYield else fail "unknown enumeration member"
instance ToJSON YieldJobFilterJobType where
  toJSON YieldJobFilterJobTypeYield = String "yield"


