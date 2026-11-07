-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Expected
  ( Expected(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data Expected = Expected { expectedDid :: Text, expectedName :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON Expected where
  parseJSON = checked "Expected" $ withObject "Expected" (\fields -> Expected <$> fields .: "did" <*> optional fields "name")
instance ToJSON Expected where toJSON value = Object (KM.fromList (concat [[("did", toJSON (expectedDid value))], optionalPair "name" (expectedName value)]))
