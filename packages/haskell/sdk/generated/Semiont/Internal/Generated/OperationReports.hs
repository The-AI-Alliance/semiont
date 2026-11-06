-- Generated from sdk/src/awaitable.ts report unions. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.OperationReports (JobEvent(..), UploadEvent(..)) where
import Data.Aeson (ToJSON(..), object, (.=))
import Data.Text (Text)
import Semiont.Types
import Semiont.Internal.Transport (FrameRefusal(..))
import Semiont.Internal.Required (Fault(..), FaultReason(..))
data JobEvent completion = Created JobCreatedResultResponse | Progress JobProgress | Failed JobFailCommand | Refused FrameRefusal | Complete completion deriving (Eq, Show)
instance ToJSON completion => ToJSON (JobEvent completion) where
  toJSON (Created value0) = object ["kind" .= ("created" :: Text), "data" .= value0]
  toJSON (Progress value0) = object ["kind" .= ("progress" :: Text), "data" .= value0]
  toJSON (Failed value0) = object ["kind" .= ("failed" :: Text), "data" .= value0]
  toJSON (Refused value0) = object ["kind" .= ("refused" :: Text), "data" .= object ["channel" .= refusedChannel value0, "member" .= member (fault value0), "reason" .= (case reason (fault value0) of Lacks -> ("lacks" :: Text); Malformed -> "malformed")]]
  toJSON (Complete value0) = object ["kind" .= ("complete" :: Text), "data" .= value0]

data UploadEvent = UploadStarted Integer | UploadProgress Integer Integer | UploadFinished ResourceId deriving (Eq, Show)
instance ToJSON (UploadEvent) where
  toJSON (UploadStarted value0) = object ["phase" .= ("started" :: Text), "totalBytes" .= value0]
  toJSON (UploadProgress value0 value1) = object ["phase" .= ("progress" :: Text), "bytesUploaded" .= value0, "totalBytes" .= value1]
  toJSON (UploadFinished value0) = object ["phase" .= ("finished" :: Text), "resourceId" .= value0]
