-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.IssuedTokens
  ( IssuedTokens(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data IssuedTokens = IssuedTokens { issuedTokensAccess :: Text, issuedTokensRefresh :: Text, issuedTokensAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON IssuedTokens where
  parseJSON = checked "IssuedTokens" $ withObject "IssuedTokens" (\fields -> IssuedTokens <$> fields .: "access" <*> fields .: "refresh" <*> traverse parseJSON (withoutFields ["access", "refresh"] fields))
instance ToJSON IssuedTokens where toJSON value = Object (KM.fromList (concat [[("access", toJSON (issuedTokensAccess value))], [("refresh", toJSON (issuedTokensRefresh value))]]) <> fmap toJSON (withoutFields ["access", "refresh"] (issuedTokensAdditionalProperties value)))
