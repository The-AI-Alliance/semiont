-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobRecord
  ( JobRecord(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Job
data JobRecord = JobRecord { jobRecordJob :: Job, jobRecordLastProgressAt :: Text } deriving (Eq, Show)
instance FromJSON JobRecord where
  parseJSON = checked "JobRecord" $ withObject "JobRecord" (\fields -> JobRecord <$> fields .: "job" <*> fields .: "lastProgressAt")
instance ToJSON JobRecord where toJSON value = Object (KM.fromList (concat [[("job", toJSON (jobRecordJob value))], [("lastProgressAt", toJSON (jobRecordLastProgressAt value))]]))
