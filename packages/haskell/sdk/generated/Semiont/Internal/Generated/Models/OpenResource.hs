-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.OpenResource
  ( OpenResource(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
data OpenResource = OpenResource { openResourceId :: ResourceId, openResourceMediaType :: Maybe (Text), openResourceName :: Text, openResourceOpenedAt :: Integer, openResourceOrder :: Integer, openResourceStorageUri :: Maybe (Text), openResourceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON OpenResource where
  parseJSON = checked "OpenResource" $ withObject "OpenResource" (\fields -> OpenResource <$> fields .: "id" <*> optional fields "mediaType" <*> fields .: "name" <*> fields .: "openedAt" <*> fields .: "order" <*> optional fields "storageUri" <*> traverse parseJSON (withoutFields ["id", "mediaType", "name", "openedAt", "order", "storageUri"] fields))
instance ToJSON OpenResource where toJSON value = Object (KM.fromList (concat [[("id", toJSON (openResourceId value))], optionalPair "mediaType" (openResourceMediaType value), [("name", toJSON (openResourceName value))], [("openedAt", toJSON (openResourceOpenedAt value))], [("order", toJSON (openResourceOrder value))], optionalPair "storageUri" (openResourceStorageUri value)]) <> fmap toJSON (withoutFields ["id", "mediaType", "name", "openedAt", "order", "storageUri"] (openResourceAdditionalProperties value)))
