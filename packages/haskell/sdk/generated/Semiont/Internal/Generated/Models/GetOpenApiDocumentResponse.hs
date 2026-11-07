-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetOpenApiDocumentResponse
  ( GetOpenApiDocumentResponse(..)
  , GetOpenApiDocumentResponseInfo(..)
  , GetOpenApiDocumentResponsePaths(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data GetOpenApiDocumentResponse = GetOpenApiDocumentResponse { getOpenApiDocumentResponseInfo :: GetOpenApiDocumentResponseInfo, getOpenApiDocumentResponseOpenapi :: Text, getOpenApiDocumentResponsePaths :: GetOpenApiDocumentResponsePaths, getOpenApiDocumentResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetOpenApiDocumentResponse where
  parseJSON = checked "GetOpenApiDocumentResponse" $ withObject "GetOpenApiDocumentResponse" (\fields -> GetOpenApiDocumentResponse <$> fields .: "info" <*> fields .: "openapi" <*> fields .: "paths" <*> traverse parseJSON (withoutFields ["info", "openapi", "paths"] fields))
instance ToJSON GetOpenApiDocumentResponse where toJSON value = Object (KM.fromList (concat [[("info", toJSON (getOpenApiDocumentResponseInfo value))], [("openapi", toJSON (getOpenApiDocumentResponseOpenapi value))], [("paths", toJSON (getOpenApiDocumentResponsePaths value))]]) <> fmap toJSON (withoutFields ["info", "openapi", "paths"] (getOpenApiDocumentResponseAdditionalProperties value)))

data GetOpenApiDocumentResponseInfo = GetOpenApiDocumentResponseInfo { getOpenApiDocumentResponseInfoAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetOpenApiDocumentResponseInfo where
  parseJSON = checked "GetOpenApiDocumentResponseInfo" $ withObject "GetOpenApiDocumentResponseInfo" (\fields -> GetOpenApiDocumentResponseInfo <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GetOpenApiDocumentResponseInfo where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (getOpenApiDocumentResponseInfoAdditionalProperties value)))

data GetOpenApiDocumentResponsePaths = GetOpenApiDocumentResponsePaths { getOpenApiDocumentResponsePathsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetOpenApiDocumentResponsePaths where
  parseJSON = checked "GetOpenApiDocumentResponsePaths" $ withObject "GetOpenApiDocumentResponsePaths" (\fields -> GetOpenApiDocumentResponsePaths <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GetOpenApiDocumentResponsePaths where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (getOpenApiDocumentResponsePathsAdditionalProperties value)))
