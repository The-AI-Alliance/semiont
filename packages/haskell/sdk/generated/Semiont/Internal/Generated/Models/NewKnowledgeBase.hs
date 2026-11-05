-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.NewKnowledgeBase
  ( NewKnowledgeBase(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbEndpoint
import Semiont.Internal.Generated.Models.KbRead
data NewKnowledgeBase = NewKnowledgeBase { newKnowledgeBaseDid :: Text, newKnowledgeBaseEndpoint :: KbEndpoint, newKnowledgeBaseLabel :: Text, newKnowledgeBaseLastRead :: Maybe (KbRead), newKnowledgeBaseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON NewKnowledgeBase where
  parseJSON = checked "NewKnowledgeBase" $ withObject "NewKnowledgeBase" (\fields -> NewKnowledgeBase <$> fields .: "did" <*> fields .: "endpoint" <*> fields .: "label" <*> optional fields "lastRead" <*> traverse parseJSON (withoutFields ["did", "endpoint", "label", "lastRead"] fields))
instance ToJSON NewKnowledgeBase where toJSON value = Object (KM.fromList (concat [[("did", toJSON (newKnowledgeBaseDid value))], [("endpoint", toJSON (newKnowledgeBaseEndpoint value))], [("label", toJSON (newKnowledgeBaseLabel value))], optionalPair "lastRead" (newKnowledgeBaseLastRead value)]) <> fmap toJSON (withoutFields ["did", "endpoint", "label", "lastRead"] (newKnowledgeBaseAdditionalProperties value)))
