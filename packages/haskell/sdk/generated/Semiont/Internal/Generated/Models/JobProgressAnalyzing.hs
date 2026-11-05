-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressAnalyzing
  ( JobProgressAnalyzing(..)
  , JobProgressAnalyzingCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressAnalyzing = JobProgressAnalyzing { jobProgressAnalyzingCode :: JobProgressAnalyzingCode, jobProgressAnalyzingAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressAnalyzing where
  parseJSON = checked "JobProgressAnalyzing" $ withObject "JobProgressAnalyzing" (\fields -> JobProgressAnalyzing <$> fields .: "code" <*> traverse parseJSON (withoutFields ["code"] fields))
instance ToJSON JobProgressAnalyzing where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressAnalyzingCode value))]]) <> fmap toJSON (withoutFields ["code"] (jobProgressAnalyzingAdditionalProperties value)))

data JobProgressAnalyzingCode = JobProgressAnalyzingCodeAnalyzing deriving (Eq, Show)
instance FromJSON JobProgressAnalyzingCode where
  parseJSON = checked "JobProgressAnalyzingCode" $ \value -> if value == (String "analyzing") then pure JobProgressAnalyzingCodeAnalyzing else fail "unknown enumeration member"
instance ToJSON JobProgressAnalyzingCode where
  toJSON JobProgressAnalyzingCodeAnalyzing = String "analyzing"


