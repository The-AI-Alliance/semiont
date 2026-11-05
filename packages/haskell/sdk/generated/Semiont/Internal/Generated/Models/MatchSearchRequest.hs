-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchSearchRequest
  ( MatchSearchRequest(..)
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
import Semiont.Internal.Generated.Models.GatheredContext
import Semiont.Internal.Generated.Models.ResourceId
data MatchSearchRequest = MatchSearchRequest { matchSearchRequestContext :: GatheredContext, matchSearchRequestLimit :: Maybe (Integer), matchSearchRequestReferenceId :: AnnotationId, matchSearchRequestResourceId :: ResourceId, matchSearchRequestUseSemanticScoring :: Maybe (Bool), matchSearchRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchSearchRequest where
  parseJSON = checked "MatchSearchRequest" $ withObject "MatchSearchRequest" (\fields -> MatchSearchRequest <$> fields .: "context" <*> optional fields "limit" <*> fields .: "referenceId" <*> fields .: "resourceId" <*> optional fields "useSemanticScoring" <*> traverse parseJSON (withoutFields ["context", "limit", "referenceId", "resourceId", "useSemanticScoring"] fields))
instance ToJSON MatchSearchRequest where toJSON value = Object (KM.fromList (concat [[("context", toJSON (matchSearchRequestContext value))], optionalPair "limit" (matchSearchRequestLimit value), [("referenceId", toJSON (matchSearchRequestReferenceId value))], [("resourceId", toJSON (matchSearchRequestResourceId value))], optionalPair "useSemanticScoring" (matchSearchRequestUseSemanticScoring value)]) <> fmap toJSON (withoutFields ["context", "limit", "referenceId", "resourceId", "useSemanticScoring"] (matchSearchRequestAdditionalProperties value)))

