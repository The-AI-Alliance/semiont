-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobStatusResult
  ( JobStatusResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobStatusResponse
data JobStatusResult = JobStatusResult { jobStatusResultResponse :: JobStatusResponse, jobStatusResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobStatusResult where
  parseJSON = checked "JobStatusResult" $ withObject "JobStatusResult" (\fields -> JobStatusResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON JobStatusResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (jobStatusResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (jobStatusResultAdditionalProperties value)))

