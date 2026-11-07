-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobParams
  ( JobParams(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.TagSchema
data JobParams = JobParams { jobParamsResourceId :: ResourceId, jobParamsSchema :: Maybe (TagSchema), jobParamsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobParams where
  parseJSON = checked "JobParams" $ withObject "JobParams" (\fields -> JobParams <$> fields .: "resourceId" <*> optional fields "schema" <*> traverse parseJSON (withoutFields ["resourceId", "schema"] fields))
instance ToJSON JobParams where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (jobParamsResourceId value))], optionalPair "schema" (jobParamsSchema value)]) <> fmap toJSON (withoutFields ["resourceId", "schema"] (jobParamsAdditionalProperties value)))
