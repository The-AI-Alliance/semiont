-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.UserResponse
  ( UserResponse(..)
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
data UserResponse = UserResponse { userResponseDid :: UserId, userResponseDomain :: Text, userResponseEmail :: Maybe (Text), userResponseImage :: Maybe (Text), userResponseName :: Maybe (Text), userResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON UserResponse where
  parseJSON = checked "UserResponse" $ withObject "UserResponse" (\fields -> UserResponse <$> fields .: "did" <*> fields .: "domain" <*> fields .: "email" <*> fields .: "image" <*> fields .: "name" <*> traverse parseJSON (withoutFields ["did", "domain", "email", "image", "name"] fields))
instance ToJSON UserResponse where toJSON value = Object (KM.fromList (concat [[("did", toJSON (userResponseDid value))], [("domain", toJSON (userResponseDomain value))], [("email", toJSON (userResponseEmail value))], [("image", toJSON (userResponseImage value))], [("name", toJSON (userResponseName value))]]) <> fmap toJSON (withoutFields ["did", "domain", "email", "image", "name"] (userResponseAdditionalProperties value)))

