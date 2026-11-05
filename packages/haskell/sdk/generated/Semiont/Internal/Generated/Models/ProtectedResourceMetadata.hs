-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ProtectedResourceMetadata
  ( ProtectedResourceMetadata(..)
  , ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ProtectedResourceMetadata = ProtectedResourceMetadata { protectedResourceMetadataAuthorizationU5f_servers :: [Text], protectedResourceMetadataBearerU5f_methodsU5f_supported :: [ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem], protectedResourceMetadataResource :: Text, protectedResourceMetadataResourceU5f_name :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON ProtectedResourceMetadata where
  parseJSON = checked "ProtectedResourceMetadata" $ withObject "ProtectedResourceMetadata" (\fields -> ProtectedResourceMetadata <$> fields .: "authorization_servers" <*> fields .: "bearer_methods_supported" <*> fields .: "resource" <*> optional fields "resource_name")
instance ToJSON ProtectedResourceMetadata where toJSON value = Object (KM.fromList (concat [[("authorization_servers", toJSON (protectedResourceMetadataAuthorizationU5f_servers value))], [("bearer_methods_supported", toJSON (protectedResourceMetadataBearerU5f_methodsU5f_supported value))], [("resource", toJSON (protectedResourceMetadataResource value))], optionalPair "resource_name" (protectedResourceMetadataResourceU5f_name value)]))

data ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem = ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItemHeader deriving (Eq, Show)
instance FromJSON ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem where
  parseJSON = checked "ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem" $ \value -> if value == (String "header") then pure ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItemHeader else fail "unknown enumeration member"
instance ToJSON ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItem where
  toJSON ProtectedResourceMetadataBearerU5f_methodsU5f_supportedItemHeader = String "header"
