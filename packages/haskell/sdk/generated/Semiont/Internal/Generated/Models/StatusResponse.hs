-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.StatusResponse
  ( StatusResponse(..)
  , StatusResponseFeatures(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data StatusResponse = StatusResponse { statusResponseAuthenticatedAs :: Maybe (Text), statusResponseFeatures :: StatusResponseFeatures, statusResponseMessage :: Text, statusResponseStatus :: Text, statusResponseVersion :: Text, statusResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON StatusResponse where
  parseJSON = checked "StatusResponse" $ withObject "StatusResponse" (\fields -> StatusResponse <$> optional fields "authenticatedAs" <*> fields .: "features" <*> fields .: "message" <*> fields .: "status" <*> fields .: "version" <*> traverse parseJSON (withoutFields ["authenticatedAs", "features", "message", "status", "version"] fields))
instance ToJSON StatusResponse where toJSON value = Object (KM.fromList (concat [optionalPair "authenticatedAs" (statusResponseAuthenticatedAs value), [("features", toJSON (statusResponseFeatures value))], [("message", toJSON (statusResponseMessage value))], [("status", toJSON (statusResponseStatus value))], [("version", toJSON (statusResponseVersion value))]]) <> fmap toJSON (withoutFields ["authenticatedAs", "features", "message", "status", "version"] (statusResponseAdditionalProperties value)))

data StatusResponseFeatures = StatusResponseFeatures { statusResponseFeaturesCollaboration :: Text, statusResponseFeaturesSemanticContent :: Text, statusResponseFeaturesAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON StatusResponseFeatures where
  parseJSON = checked "StatusResponseFeatures" $ withObject "StatusResponseFeatures" (\fields -> StatusResponseFeatures <$> fields .: "collaboration" <*> fields .: "semanticContent" <*> traverse parseJSON (withoutFields ["collaboration", "semanticContent"] fields))
instance ToJSON StatusResponseFeatures where toJSON value = Object (KM.fromList (concat [[("collaboration", toJSON (statusResponseFeaturesCollaboration value))], [("semanticContent", toJSON (statusResponseFeaturesSemanticContent value))]]) <> fmap toJSON (withoutFields ["collaboration", "semanticContent"] (statusResponseFeaturesAdditionalProperties value)))
