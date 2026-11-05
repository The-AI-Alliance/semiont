-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldJobQueuedEvent
  ( YieldJobQueuedEvent(..)
  , YieldJobQueuedEventJobType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GenerationJobRequest
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data YieldJobQueuedEvent = YieldJobQueuedEvent { yieldJobQueuedEventJobId :: JobId, yieldJobQueuedEventJobType :: YieldJobQueuedEventJobType, yieldJobQueuedEventParams :: GenerationJobRequest, yieldJobQueuedEventResourceId :: ResourceId, yieldJobQueuedEventUserId :: UserId, yieldJobQueuedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldJobQueuedEvent where
  parseJSON = checked "YieldJobQueuedEvent" $ withObject "YieldJobQueuedEvent" (\fields -> YieldJobQueuedEvent <$> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "params" <*> fields .: "resourceId" <*> fields .: "userId" <*> traverse parseJSON (withoutFields ["jobId", "jobType", "params", "resourceId", "userId"] fields))
instance ToJSON YieldJobQueuedEvent where toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (yieldJobQueuedEventJobId value))], [("jobType", toJSON (yieldJobQueuedEventJobType value))], [("params", toJSON (yieldJobQueuedEventParams value))], [("resourceId", toJSON (yieldJobQueuedEventResourceId value))], [("userId", toJSON (yieldJobQueuedEventUserId value))]]) <> fmap toJSON (withoutFields ["jobId", "jobType", "params", "resourceId", "userId"] (yieldJobQueuedEventAdditionalProperties value)))

data YieldJobQueuedEventJobType = YieldJobQueuedEventJobTypeYield deriving (Eq, Show)
instance FromJSON YieldJobQueuedEventJobType where
  parseJSON = checked "YieldJobQueuedEventJobType" $ \value -> if value == (String "yield") then pure YieldJobQueuedEventJobTypeYield else fail "unknown enumeration member"
instance ToJSON YieldJobQueuedEventJobType where
  toJSON YieldJobQueuedEventJobTypeYield = String "yield"


