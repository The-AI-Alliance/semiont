-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressCreatingAnnotations
  ( JobProgressCreatingAnnotations(..)
  , JobProgressCreatingAnnotationsCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressCreatingAnnotations = JobProgressCreatingAnnotations { jobProgressCreatingAnnotationsCode :: JobProgressCreatingAnnotationsCode, jobProgressCreatingAnnotationsCount :: Integer, jobProgressCreatingAnnotationsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCreatingAnnotations where
  parseJSON = checked "JobProgressCreatingAnnotations" $ withObject "JobProgressCreatingAnnotations" (\fields -> JobProgressCreatingAnnotations <$> fields .: "code" <*> fields .: "count" <*> traverse parseJSON (withoutFields ["code", "count"] fields))
instance ToJSON JobProgressCreatingAnnotations where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressCreatingAnnotationsCode value))], [("count", toJSON (jobProgressCreatingAnnotationsCount value))]]) <> fmap toJSON (withoutFields ["code", "count"] (jobProgressCreatingAnnotationsAdditionalProperties value)))

data JobProgressCreatingAnnotationsCode = JobProgressCreatingAnnotationsCodeCreatingU2d_annotations deriving (Eq, Show)
instance FromJSON JobProgressCreatingAnnotationsCode where
  parseJSON = checked "JobProgressCreatingAnnotationsCode" $ \value -> if value == (String "creating-annotations") then pure JobProgressCreatingAnnotationsCodeCreatingU2d_annotations else fail "unknown enumeration member"
instance ToJSON JobProgressCreatingAnnotationsCode where
  toJSON JobProgressCreatingAnnotationsCodeCreatingU2d_annotations = String "creating-annotations"


