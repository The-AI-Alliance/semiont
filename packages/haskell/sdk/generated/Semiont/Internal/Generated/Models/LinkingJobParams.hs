-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.LinkingJobParams
  ( LinkingJobParams(..)
  , LinkingJobParamsMotivation(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data LinkingJobParams = LinkingJobParams { linkingJobParamsEntityTypes :: [Text], linkingJobParamsIncludeDescriptiveReferences :: Maybe (Bool), linkingJobParamsLanguage :: Maybe (Text), linkingJobParamsMotivation :: LinkingJobParamsMotivation, linkingJobParamsSourceLanguage :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON LinkingJobParams where
  parseJSON = checked "LinkingJobParams" $ withObject "LinkingJobParams" (\fields -> LinkingJobParams <$> fields .: "entityTypes" <*> optional fields "includeDescriptiveReferences" <*> optional fields "language" <*> fields .: "motivation" <*> optional fields "sourceLanguage")
instance ToJSON LinkingJobParams where toJSON value = Object (KM.fromList (concat [[("entityTypes", toJSON (linkingJobParamsEntityTypes value))], optionalPair "includeDescriptiveReferences" (linkingJobParamsIncludeDescriptiveReferences value), optionalPair "language" (linkingJobParamsLanguage value), [("motivation", toJSON (linkingJobParamsMotivation value))], optionalPair "sourceLanguage" (linkingJobParamsSourceLanguage value)]))

data LinkingJobParamsMotivation = LinkingJobParamsMotivationLinking deriving (Eq, Show)
instance FromJSON LinkingJobParamsMotivation where
  parseJSON = checked "LinkingJobParamsMotivation" $ \value -> if value == (String "linking") then pure LinkingJobParamsMotivationLinking else fail "unknown enumeration member"
instance ToJSON LinkingJobParamsMotivation where
  toJSON LinkingJobParamsMotivationLinking = String "linking"
