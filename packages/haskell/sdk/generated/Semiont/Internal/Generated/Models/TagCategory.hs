-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TagCategory
  ( TagCategory(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data TagCategory = TagCategory { tagCategoryDescription :: Text, tagCategoryExamples :: [Text], tagCategoryName :: Text, tagCategoryAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TagCategory where
  parseJSON = checked "TagCategory" $ withObject "TagCategory" (\fields -> TagCategory <$> fields .: "description" <*> fields .: "examples" <*> fields .: "name" <*> traverse parseJSON (withoutFields ["description", "examples", "name"] fields))
instance ToJSON TagCategory where toJSON value = Object (KM.fromList (concat [[("description", toJSON (tagCategoryDescription value))], [("examples", toJSON (tagCategoryExamples value))], [("name", toJSON (tagCategoryName value))]]) <> fmap toJSON (withoutFields ["description", "examples", "name"] (tagCategoryAdditionalProperties value)))

