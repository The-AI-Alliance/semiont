-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobAssignedPayload
  ( JobAssignedPayload(..)
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
import Semiont.Internal.Generated.Models.JobType
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data JobAssignedPayload = JobAssignedPayload { jobAssignedPayloadHolder :: UserId, jobAssignedPayloadJobId :: JobId, jobAssignedPayloadJobType :: JobType, jobAssignedPayloadRequester :: UserId, jobAssignedPayloadResourceId :: ResourceId, jobAssignedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobAssignedPayload where
  parseJSON = checked "JobAssignedPayload" $ withObject "JobAssignedPayload" (\fields -> JobAssignedPayload <$> fields .: "holder" <*> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "requester" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["holder", "jobId", "jobType", "requester", "resourceId"] fields))
instance ToJSON JobAssignedPayload where toJSON value = Object (KM.fromList (concat [[("holder", toJSON (jobAssignedPayloadHolder value))], [("jobId", toJSON (jobAssignedPayloadJobId value))], [("jobType", toJSON (jobAssignedPayloadJobType value))], [("requester", toJSON (jobAssignedPayloadRequester value))], [("resourceId", toJSON (jobAssignedPayloadResourceId value))]]) <> fmap toJSON (withoutFields ["holder", "jobId", "jobType", "requester", "resourceId"] (jobAssignedPayloadAdditionalProperties value)))

