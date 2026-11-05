-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchSearchResult
  ( MatchSearchResult(..)
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
import Semiont.Internal.Generated.Models.ScoredResource
data MatchSearchResult = MatchSearchResult { matchSearchResultReferenceId :: AnnotationId, matchSearchResultResponse :: [ScoredResource], matchSearchResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchSearchResult where
  parseJSON = checked "MatchSearchResult" $ withObject "MatchSearchResult" (\fields -> MatchSearchResult <$> fields .: "referenceId" <*> fields .: "response" <*> traverse parseJSON (withoutFields ["referenceId", "response"] fields))
instance ToJSON MatchSearchResult where toJSON value = Object (KM.fromList (concat [[("referenceId", toJSON (matchSearchResultReferenceId value))], [("response", toJSON (matchSearchResultResponse value))]]) <> fmap toJSON (withoutFields ["referenceId", "response"] (matchSearchResultAdditionalProperties value)))

