-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressCompleteGenerated
  ( JobProgressCompleteGenerated(..)
  , JobProgressCompleteGeneratedCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressCompleteGenerated = JobProgressCompleteGenerated { jobProgressCompleteGeneratedCode :: JobProgressCompleteGeneratedCode, jobProgressCompleteGeneratedTruncated :: Bool, jobProgressCompleteGeneratedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCompleteGenerated where
  parseJSON = checked "JobProgressCompleteGenerated" $ withObject "JobProgressCompleteGenerated" (\fields -> JobProgressCompleteGenerated <$> fields .: "code" <*> fields .: "truncated" <*> traverse parseJSON (withoutFields ["code", "truncated"] fields))
instance ToJSON JobProgressCompleteGenerated where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressCompleteGeneratedCode value))], [("truncated", toJSON (jobProgressCompleteGeneratedTruncated value))]]) <> fmap toJSON (withoutFields ["code", "truncated"] (jobProgressCompleteGeneratedAdditionalProperties value)))

data JobProgressCompleteGeneratedCode = JobProgressCompleteGeneratedCodeCompleteU2d_generated deriving (Eq, Show)
instance FromJSON JobProgressCompleteGeneratedCode where
  parseJSON = checked "JobProgressCompleteGeneratedCode" $ \value -> if value == (String "complete-generated") then pure JobProgressCompleteGeneratedCodeCompleteU2d_generated else fail "unknown enumeration member"
instance ToJSON JobProgressCompleteGeneratedCode where
  toJSON JobProgressCompleteGeneratedCodeCompleteU2d_generated = String "complete-generated"
