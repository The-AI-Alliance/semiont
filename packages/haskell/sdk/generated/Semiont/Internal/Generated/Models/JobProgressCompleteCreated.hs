-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressCompleteCreated
  ( JobProgressCompleteCreated(..)
  , JobProgressCompleteCreatedCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Motivation
data JobProgressCompleteCreated = JobProgressCompleteCreated { jobProgressCompleteCreatedCode :: JobProgressCompleteCreatedCode, jobProgressCompleteCreatedCount :: Integer, jobProgressCompleteCreatedMotivation :: Motivation, jobProgressCompleteCreatedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCompleteCreated where
  parseJSON = checked "JobProgressCompleteCreated" $ withObject "JobProgressCompleteCreated" (\fields -> JobProgressCompleteCreated <$> fields .: "code" <*> fields .: "count" <*> fields .: "motivation" <*> traverse parseJSON (withoutFields ["code", "count", "motivation"] fields))
instance ToJSON JobProgressCompleteCreated where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressCompleteCreatedCode value))], [("count", toJSON (jobProgressCompleteCreatedCount value))], [("motivation", toJSON (jobProgressCompleteCreatedMotivation value))]]) <> fmap toJSON (withoutFields ["code", "count", "motivation"] (jobProgressCompleteCreatedAdditionalProperties value)))

data JobProgressCompleteCreatedCode = JobProgressCompleteCreatedCodeCompleteU2d_created deriving (Eq, Show)
instance FromJSON JobProgressCompleteCreatedCode where
  parseJSON = checked "JobProgressCompleteCreatedCode" $ \value -> if value == (String "complete-created") then pure JobProgressCompleteCreatedCodeCompleteU2d_created else fail "unknown enumeration member"
instance ToJSON JobProgressCompleteCreatedCode where
  toJSON JobProgressCompleteCreatedCodeCompleteU2d_created = String "complete-created"
