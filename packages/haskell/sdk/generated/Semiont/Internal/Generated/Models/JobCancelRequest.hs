-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCancelRequest
  ( JobCancelRequest(..)
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
data JobCancelRequest = JobCancelRequest { jobCancelRequestJobId :: JobId, jobCancelRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobCancelRequest where
  parseJSON = checked "JobCancelRequest" $ withObject "JobCancelRequest" (\fields -> JobCancelRequest <$> fields .: "jobId" <*> traverse parseJSON (withoutFields ["jobId"] fields))
instance ToJSON JobCancelRequest where toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (jobCancelRequestJobId value))]]) <> fmap toJSON (withoutFields ["jobId"] (jobCancelRequestAdditionalProperties value)))

