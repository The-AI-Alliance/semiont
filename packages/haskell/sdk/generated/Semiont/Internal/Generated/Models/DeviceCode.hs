-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DeviceCode
  ( DeviceCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data DeviceCode = DeviceCode { deviceCodeExpiresIn :: Scientific, deviceCodeUserCode :: Text, deviceCodeVerificationUri :: Text, deviceCodeVerificationUriComplete :: Maybe (Text), deviceCodeAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON DeviceCode where
  parseJSON = checked "DeviceCode" $ withObject "DeviceCode" (\fields -> DeviceCode <$> fields .: "expiresIn" <*> fields .: "userCode" <*> fields .: "verificationUri" <*> optional fields "verificationUriComplete" <*> traverse parseJSON (withoutFields ["expiresIn", "userCode", "verificationUri", "verificationUriComplete"] fields))
instance ToJSON DeviceCode where toJSON value = Object (KM.fromList (concat [[("expiresIn", toJSON (deviceCodeExpiresIn value))], [("userCode", toJSON (deviceCodeUserCode value))], [("verificationUri", toJSON (deviceCodeVerificationUri value))], optionalPair "verificationUriComplete" (deviceCodeVerificationUriComplete value)]) <> fmap toJSON (withoutFields ["expiresIn", "userCode", "verificationUri", "verificationUriComplete"] (deviceCodeAdditionalProperties value)))
