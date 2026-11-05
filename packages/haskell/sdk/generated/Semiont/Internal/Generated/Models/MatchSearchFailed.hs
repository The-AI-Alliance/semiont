-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchSearchFailed
  ( MatchSearchFailed(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
data MatchSearchFailed = MatchSearchFailed { matchSearchFailedError :: Text, matchSearchFailedReferenceId :: AnnotationId, matchSearchFailedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchSearchFailed where
  parseJSON = checked "MatchSearchFailed" $ withObject "MatchSearchFailed" (\fields -> MatchSearchFailed <$> fields .: "error" <*> fields .: "referenceId" <*> traverse parseJSON (withoutFields ["error", "referenceId"] fields))
instance ToJSON MatchSearchFailed where toJSON value = Object (KM.fromList (concat [[("error", toJSON (matchSearchFailedError value))], [("referenceId", toJSON (matchSearchFailedReferenceId value))]]) <> fmap toJSON (withoutFields ["error", "referenceId"] (matchSearchFailedAdditionalProperties value)))
