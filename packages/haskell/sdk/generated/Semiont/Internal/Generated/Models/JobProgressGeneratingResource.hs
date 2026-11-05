-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressGeneratingResource
  ( JobProgressGeneratingResource(..)
  , JobProgressGeneratingResourceCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressGeneratingResource = JobProgressGeneratingResource { jobProgressGeneratingResourceCode :: JobProgressGeneratingResourceCode, jobProgressGeneratingResourceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressGeneratingResource where
  parseJSON = checked "JobProgressGeneratingResource" $ withObject "JobProgressGeneratingResource" (\fields -> JobProgressGeneratingResource <$> fields .: "code" <*> traverse parseJSON (withoutFields ["code"] fields))
instance ToJSON JobProgressGeneratingResource where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressGeneratingResourceCode value))]]) <> fmap toJSON (withoutFields ["code"] (jobProgressGeneratingResourceAdditionalProperties value)))

data JobProgressGeneratingResourceCode = JobProgressGeneratingResourceCodeGeneratingU2d_resource deriving (Eq, Show)
instance FromJSON JobProgressGeneratingResourceCode where
  parseJSON = checked "JobProgressGeneratingResourceCode" $ \value -> if value == (String "generating-resource") then pure JobProgressGeneratingResourceCodeGeneratingU2d_resource else fail "unknown enumeration member"
instance ToJSON JobProgressGeneratingResourceCode where
  toJSON JobProgressGeneratingResourceCodeGeneratingU2d_resource = String "generating-resource"
