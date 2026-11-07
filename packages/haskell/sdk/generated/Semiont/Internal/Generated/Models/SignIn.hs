-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SignIn
  ( SignIn(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data SignIn = SignIn { signInEmail :: Maybe (Text), signInExpiresAt :: Maybe (Text), signInIssuer :: Text, signInObtainedAt :: Text, signInRefreshToken :: Maybe (Text), signInRevocationEndpoint :: Maybe (Text), signInToken :: Text, signInTokenEndpoint :: Text, signInAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SignIn where
  parseJSON = checked "SignIn" $ withObject "SignIn" (\fields -> SignIn <$> optional fields "email" <*> optional fields "expiresAt" <*> fields .: "issuer" <*> fields .: "obtainedAt" <*> optional fields "refreshToken" <*> optional fields "revocationEndpoint" <*> fields .: "token" <*> fields .: "tokenEndpoint" <*> traverse parseJSON (withoutFields ["email", "expiresAt", "issuer", "obtainedAt", "refreshToken", "revocationEndpoint", "token", "tokenEndpoint"] fields))
instance ToJSON SignIn where toJSON value = Object (KM.fromList (concat [optionalPair "email" (signInEmail value), optionalPair "expiresAt" (signInExpiresAt value), [("issuer", toJSON (signInIssuer value))], [("obtainedAt", toJSON (signInObtainedAt value))], optionalPair "refreshToken" (signInRefreshToken value), optionalPair "revocationEndpoint" (signInRevocationEndpoint value), [("token", toJSON (signInToken value))], [("tokenEndpoint", toJSON (signInTokenEndpoint value))]]) <> fmap toJSON (withoutFields ["email", "expiresAt", "issuer", "obtainedAt", "refreshToken", "revocationEndpoint", "token", "tokenEndpoint"] (signInAdditionalProperties value)))
