-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkJobFilter
  ( MarkJobFilter(..)
  , MarkJobFilterJobType(..)
  , MarkJobFilterParams(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Motivation
data MarkJobFilter = MarkJobFilter { markJobFilterJobType :: MarkJobFilterJobType, markJobFilterParams :: MarkJobFilterParams } deriving (Eq, Show)
instance FromJSON MarkJobFilter where
  parseJSON = checked "MarkJobFilter" $ withObject "MarkJobFilter" (\fields -> MarkJobFilter <$> fields .: "jobType" <*> fields .: "params")
instance ToJSON MarkJobFilter where toJSON value = Object (KM.fromList (concat [[("jobType", toJSON (markJobFilterJobType value))], [("params", toJSON (markJobFilterParams value))]]))

data MarkJobFilterJobType = MarkJobFilterJobTypeMark deriving (Eq, Show)
instance FromJSON MarkJobFilterJobType where
  parseJSON = checked "MarkJobFilterJobType" $ \value -> if value == (String "mark") then pure MarkJobFilterJobTypeMark else fail "unknown enumeration member"
instance ToJSON MarkJobFilterJobType where
  toJSON MarkJobFilterJobTypeMark = String "mark"


data MarkJobFilterParams = MarkJobFilterParams { markJobFilterParamsMotivation :: Motivation } deriving (Eq, Show)
instance FromJSON MarkJobFilterParams where
  parseJSON = checked "MarkJobFilterParams" $ withObject "MarkJobFilterParams" (\fields -> MarkJobFilterParams <$> fields .: "motivation")
instance ToJSON MarkJobFilterParams where toJSON value = Object (KM.fromList (concat [[("motivation", toJSON (markJobFilterParamsMotivation value))]]))

