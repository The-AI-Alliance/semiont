-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobStatusRequest
  ( JobStatusRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobId
data JobStatusRequest = JobStatusRequest { jobStatusRequestJobId :: JobId, jobStatusRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobStatusRequest where
  parseJSON = checked "JobStatusRequest" $ withObject "JobStatusRequest" (\fields -> JobStatusRequest <$> fields .: "jobId" <*> traverse parseJSON (withoutFields ["jobId"] fields))
instance ToJSON JobStatusRequest where toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (jobStatusRequestJobId value))]]) <> fmap toJSON (withoutFields ["jobId"] (jobStatusRequestAdditionalProperties value)))

