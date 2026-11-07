-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkUnarchiveCommand
  ( MarkUnarchiveCommand(..)
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
import Semiont.Internal.Generated.Models.UserId
data MarkUnarchiveCommand = MarkUnarchiveCommand { markUnarchiveCommandU5f_userId :: Maybe (UserId), markUnarchiveCommandResourceId :: ResourceId, markUnarchiveCommandStorageUri :: Maybe (Text), markUnarchiveCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkUnarchiveCommand where
  parseJSON = checked "MarkUnarchiveCommand" $ withObject "MarkUnarchiveCommand" (\fields -> MarkUnarchiveCommand <$> optional fields "_userId" <*> fields .: "resourceId" <*> optional fields "storageUri" <*> traverse parseJSON (withoutFields ["_userId", "resourceId", "storageUri"] fields))
instance ToJSON MarkUnarchiveCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (markUnarchiveCommandU5f_userId value), [("resourceId", toJSON (markUnarchiveCommandResourceId value))], optionalPair "storageUri" (markUnarchiveCommandStorageUri value)]) <> fmap toJSON (withoutFields ["_userId", "resourceId", "storageUri"] (markUnarchiveCommandAdditionalProperties value)))
