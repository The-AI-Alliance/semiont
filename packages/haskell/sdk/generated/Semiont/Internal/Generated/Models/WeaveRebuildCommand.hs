-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WeaveRebuildCommand
  ( WeaveRebuildCommand(..)
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
data WeaveRebuildCommand = WeaveRebuildCommand { weaveRebuildCommandU5f_userId :: Maybe (UserId), weaveRebuildCommandResourceId :: Maybe (ResourceId), weaveRebuildCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON WeaveRebuildCommand where
  parseJSON = checked "WeaveRebuildCommand" $ withObject "WeaveRebuildCommand" (\fields -> WeaveRebuildCommand <$> optional fields "_userId" <*> optional fields "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "resourceId"] fields))
instance ToJSON WeaveRebuildCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (weaveRebuildCommandU5f_userId value), optionalPair "resourceId" (weaveRebuildCommandResourceId value)]) <> fmap toJSON (withoutFields ["_userId", "resourceId"] (weaveRebuildCommandAdditionalProperties value)))

