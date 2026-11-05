-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressLoading
  ( JobProgressLoading(..)
  , JobProgressLoadingCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressLoading = JobProgressLoading { jobProgressLoadingCode :: JobProgressLoadingCode, jobProgressLoadingAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressLoading where
  parseJSON = checked "JobProgressLoading" $ withObject "JobProgressLoading" (\fields -> JobProgressLoading <$> fields .: "code" <*> traverse parseJSON (withoutFields ["code"] fields))
instance ToJSON JobProgressLoading where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressLoadingCode value))]]) <> fmap toJSON (withoutFields ["code"] (jobProgressLoadingAdditionalProperties value)))

data JobProgressLoadingCode = JobProgressLoadingCodeLoading deriving (Eq, Show)
instance FromJSON JobProgressLoadingCode where
  parseJSON = checked "JobProgressLoadingCode" $ \value -> if value == (String "loading") then pure JobProgressLoadingCodeLoading else fail "unknown enumeration member"
instance ToJSON JobProgressLoadingCode where
  toJSON JobProgressLoadingCodeLoading = String "loading"
