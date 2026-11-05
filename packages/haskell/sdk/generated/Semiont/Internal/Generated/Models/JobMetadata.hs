-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobMetadata
  ( JobMetadata(..)
  , JobMetadataUnitCursors(..)
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
import Semiont.Internal.Generated.Models.UnitCursor
import Semiont.Internal.Generated.Models.UserId
data JobMetadata = JobMetadata { jobMetadataCompletedUnits :: Maybe ([Text]), jobMetadataCreated :: Text, jobMetadataId :: JobId, jobMetadataMaxRetries :: Integer, jobMetadataRetryCount :: Integer, jobMetadataType :: JobType, jobMetadataUnitCursors :: Maybe (JobMetadataUnitCursors), jobMetadataUserId :: UserId } deriving (Eq, Show)
instance FromJSON JobMetadata where
  parseJSON = checked "JobMetadata" $ withObject "JobMetadata" (\fields -> JobMetadata <$> optional fields "completedUnits" <*> fields .: "created" <*> fields .: "id" <*> fields .: "maxRetries" <*> fields .: "retryCount" <*> fields .: "type" <*> optional fields "unitCursors" <*> fields .: "userId")
instance ToJSON JobMetadata where toJSON value = Object (KM.fromList (concat [optionalPair "completedUnits" (jobMetadataCompletedUnits value), [("created", toJSON (jobMetadataCreated value))], [("id", toJSON (jobMetadataId value))], [("maxRetries", toJSON (jobMetadataMaxRetries value))], [("retryCount", toJSON (jobMetadataRetryCount value))], [("type", toJSON (jobMetadataType value))], optionalPair "unitCursors" (jobMetadataUnitCursors value), [("userId", toJSON (jobMetadataUserId value))]]))

data JobMetadataUnitCursors = JobMetadataUnitCursors { jobMetadataUnitCursorsAdditionalProperties :: KM.KeyMap (UnitCursor) } deriving (Eq, Show)
instance FromJSON JobMetadataUnitCursors where
  parseJSON = checked "JobMetadataUnitCursors" $ withObject "JobMetadataUnitCursors" (\fields -> JobMetadataUnitCursors <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON JobMetadataUnitCursors where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (jobMetadataUnitCursorsAdditionalProperties value)))
