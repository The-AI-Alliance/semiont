-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkJobQueuedEvent
  ( MarkJobQueuedEvent(..)
  , MarkJobQueuedEventJobType(..)
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
import Semiont.Internal.Generated.Models.MarkJobParams
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data MarkJobQueuedEvent = MarkJobQueuedEvent { markJobQueuedEventJobId :: JobId, markJobQueuedEventJobType :: MarkJobQueuedEventJobType, markJobQueuedEventParams :: MarkJobParams, markJobQueuedEventResourceId :: ResourceId, markJobQueuedEventUserId :: UserId, markJobQueuedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkJobQueuedEvent where
  parseJSON = checked "MarkJobQueuedEvent" $ withObject "MarkJobQueuedEvent" (\fields -> MarkJobQueuedEvent <$> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "params" <*> fields .: "resourceId" <*> fields .: "userId" <*> traverse parseJSON (withoutFields ["jobId", "jobType", "params", "resourceId", "userId"] fields))
instance ToJSON MarkJobQueuedEvent where toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (markJobQueuedEventJobId value))], [("jobType", toJSON (markJobQueuedEventJobType value))], [("params", toJSON (markJobQueuedEventParams value))], [("resourceId", toJSON (markJobQueuedEventResourceId value))], [("userId", toJSON (markJobQueuedEventUserId value))]]) <> fmap toJSON (withoutFields ["jobId", "jobType", "params", "resourceId", "userId"] (markJobQueuedEventAdditionalProperties value)))

data MarkJobQueuedEventJobType = MarkJobQueuedEventJobTypeMark deriving (Eq, Show)
instance FromJSON MarkJobQueuedEventJobType where
  parseJSON = checked "MarkJobQueuedEventJobType" $ \value -> if value == (String "mark") then pure MarkJobQueuedEventJobTypeMark else fail "unknown enumeration member"
instance ToJSON MarkJobQueuedEventJobType where
  toJSON MarkJobQueuedEventJobTypeMark = String "mark"


