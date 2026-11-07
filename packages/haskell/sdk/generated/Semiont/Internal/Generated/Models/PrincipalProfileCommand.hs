-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.PrincipalProfileCommand
  ( PrincipalProfileCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.UserId
data PrincipalProfileCommand = PrincipalProfileCommand { principalProfileCommandU5f_userId :: Maybe (UserId), principalProfileCommandName :: Text, principalProfileCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON PrincipalProfileCommand where
  parseJSON = checked "PrincipalProfileCommand" $ withObject "PrincipalProfileCommand" (\fields -> PrincipalProfileCommand <$> optional fields "_userId" <*> fields .: "name" <*> traverse parseJSON (withoutFields ["_userId", "name"] fields))
instance ToJSON PrincipalProfileCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (principalProfileCommandU5f_userId value), [("name", toJSON (principalProfileCommandName value))]]) <> fmap toJSON (withoutFields ["_userId", "name"] (principalProfileCommandAdditionalProperties value)))
