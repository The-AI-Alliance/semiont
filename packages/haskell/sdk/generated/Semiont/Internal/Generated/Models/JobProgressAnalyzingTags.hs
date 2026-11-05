-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressAnalyzingTags
  ( JobProgressAnalyzingTags(..)
  , JobProgressAnalyzingTagsCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressAnalyzingTags = JobProgressAnalyzingTags { jobProgressAnalyzingTagsCode :: JobProgressAnalyzingTagsCode, jobProgressAnalyzingTagsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressAnalyzingTags where
  parseJSON = checked "JobProgressAnalyzingTags" $ withObject "JobProgressAnalyzingTags" (\fields -> JobProgressAnalyzingTags <$> fields .: "code" <*> traverse parseJSON (withoutFields ["code"] fields))
instance ToJSON JobProgressAnalyzingTags where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressAnalyzingTagsCode value))]]) <> fmap toJSON (withoutFields ["code"] (jobProgressAnalyzingTagsAdditionalProperties value)))

data JobProgressAnalyzingTagsCode = JobProgressAnalyzingTagsCodeAnalyzingU2d_tags deriving (Eq, Show)
instance FromJSON JobProgressAnalyzingTagsCode where
  parseJSON = checked "JobProgressAnalyzingTagsCode" $ \value -> if value == (String "analyzing-tags") then pure JobProgressAnalyzingTagsCodeAnalyzingU2d_tags else fail "unknown enumeration member"
instance ToJSON JobProgressAnalyzingTagsCode where
  toJSON JobProgressAnalyzingTagsCodeAnalyzingU2d_tags = String "analyzing-tags"


