-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCreatedResult
  ( JobCreatedResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobCreatedResultResponse
data JobCreatedResult = JobCreatedResult { jobCreatedResultResponse :: JobCreatedResultResponse, jobCreatedResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobCreatedResult where
  parseJSON = checked "JobCreatedResult" $ withObject "JobCreatedResult" (\fields -> JobCreatedResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON JobCreatedResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (jobCreatedResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (jobCreatedResultAdditionalProperties value)))

