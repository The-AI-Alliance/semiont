-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BeginAuthorizationOptions
  ( BeginAuthorizationOptions(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.HttpEndpoint
data BeginAuthorizationOptions = BeginAuthorizationOptions { beginAuthorizationOptionsExpectedDid :: Maybe (Text), beginAuthorizationOptionsExpectedName :: Maybe (Text), beginAuthorizationOptionsKbId :: Maybe (Text), beginAuthorizationOptionsRedirectUri :: Text, beginAuthorizationOptionsTarget :: HttpEndpoint, beginAuthorizationOptionsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BeginAuthorizationOptions where
  parseJSON = checked "BeginAuthorizationOptions" $ withObject "BeginAuthorizationOptions" (\fields -> BeginAuthorizationOptions <$> optional fields "expectedDid" <*> optional fields "expectedName" <*> optional fields "kbId" <*> fields .: "redirectUri" <*> fields .: "target" <*> traverse parseJSON (withoutFields ["expectedDid", "expectedName", "kbId", "redirectUri", "target"] fields))
instance ToJSON BeginAuthorizationOptions where toJSON value = Object (KM.fromList (concat [optionalPair "expectedDid" (beginAuthorizationOptionsExpectedDid value), optionalPair "expectedName" (beginAuthorizationOptionsExpectedName value), optionalPair "kbId" (beginAuthorizationOptionsKbId value), [("redirectUri", toJSON (beginAuthorizationOptionsRedirectUri value))], [("target", toJSON (beginAuthorizationOptionsTarget value))]]) <> fmap toJSON (withoutFields ["expectedDid", "expectedName", "kbId", "redirectUri", "target"] (beginAuthorizationOptionsAdditionalProperties value)))
