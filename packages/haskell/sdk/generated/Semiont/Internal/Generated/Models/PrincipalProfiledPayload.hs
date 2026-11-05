-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.PrincipalProfiledPayload
  ( PrincipalProfiledPayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data PrincipalProfiledPayload = PrincipalProfiledPayload { principalProfiledPayloadName :: Text, principalProfiledPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON PrincipalProfiledPayload where
  parseJSON = checked "PrincipalProfiledPayload" $ withObject "PrincipalProfiledPayload" (\fields -> PrincipalProfiledPayload <$> fields .: "name" <*> traverse parseJSON (withoutFields ["name"] fields))
instance ToJSON PrincipalProfiledPayload where toJSON value = Object (KM.fromList (concat [[("name", toJSON (principalProfiledPayloadName value))]]) <> fmap toJSON (withoutFields ["name"] (principalProfiledPayloadAdditionalProperties value)))

