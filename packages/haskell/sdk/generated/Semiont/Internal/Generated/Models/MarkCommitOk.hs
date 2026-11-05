-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkCommitOk
  ( MarkCommitOk(..)
  , MarkCommitOkResponse(..)
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
data MarkCommitOk = MarkCommitOk { markCommitOkResponse :: MarkCommitOkResponse, markCommitOkAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkCommitOk where
  parseJSON = checked "MarkCommitOk" $ withObject "MarkCommitOk" (\fields -> MarkCommitOk <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON MarkCommitOk where toJSON value = Object (KM.fromList (concat [[("response", toJSON (markCommitOkResponse value))]]) <> fmap toJSON (withoutFields ["response"] (markCommitOkAdditionalProperties value)))

data MarkCommitOkResponse = MarkCommitOkResponse { markCommitOkResponseAnnotationIds :: [AnnotationId], markCommitOkResponsePersisted :: Integer, markCommitOkResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkCommitOkResponse where
  parseJSON = checked "MarkCommitOkResponse" $ withObject "MarkCommitOkResponse" (\fields -> MarkCommitOkResponse <$> fields .: "annotationIds" <*> fields .: "persisted" <*> traverse parseJSON (withoutFields ["annotationIds", "persisted"] fields))
instance ToJSON MarkCommitOkResponse where toJSON value = Object (KM.fromList (concat [[("annotationIds", toJSON (markCommitOkResponseAnnotationIds value))], [("persisted", toJSON (markCommitOkResponsePersisted value))]]) <> fmap toJSON (withoutFields ["annotationIds", "persisted"] (markCommitOkResponseAdditionalProperties value)))

