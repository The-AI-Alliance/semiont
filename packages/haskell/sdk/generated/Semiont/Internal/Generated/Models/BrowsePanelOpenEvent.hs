-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowsePanelOpenEvent
  ( BrowsePanelOpenEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.Motivation
data BrowsePanelOpenEvent = BrowsePanelOpenEvent { browsePanelOpenEventMotivation :: Maybe (Motivation), browsePanelOpenEventPanel :: Text, browsePanelOpenEventScrollToAnnotationId :: Maybe (AnnotationId), browsePanelOpenEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowsePanelOpenEvent where
  parseJSON = checked "BrowsePanelOpenEvent" $ withObject "BrowsePanelOpenEvent" (\fields -> BrowsePanelOpenEvent <$> optional fields "motivation" <*> fields .: "panel" <*> optional fields "scrollToAnnotationId" <*> traverse parseJSON (withoutFields ["motivation", "panel", "scrollToAnnotationId"] fields))
instance ToJSON BrowsePanelOpenEvent where toJSON value = Object (KM.fromList (concat [optionalPair "motivation" (browsePanelOpenEventMotivation value), [("panel", toJSON (browsePanelOpenEventPanel value))], optionalPair "scrollToAnnotationId" (browsePanelOpenEventScrollToAnnotationId value)]) <> fmap toJSON (withoutFields ["motivation", "panel", "scrollToAnnotationId"] (browsePanelOpenEventAdditionalProperties value)))

