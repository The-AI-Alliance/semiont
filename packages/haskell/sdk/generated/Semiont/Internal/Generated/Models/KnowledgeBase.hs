-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KnowledgeBase
  ( KnowledgeBase(..)
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
data KnowledgeBase = KnowledgeBase { knowledgeBaseDid :: Text, knowledgeBaseEndpoint :: KbEndpoint, knowledgeBaseId :: Text, knowledgeBaseLabel :: Text, knowledgeBaseLastRead :: Maybe (KbRead), knowledgeBaseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KnowledgeBase where
  parseJSON = checked "KnowledgeBase" $ withObject "KnowledgeBase" (\fields -> KnowledgeBase <$> fields .: "did" <*> fields .: "endpoint" <*> fields .: "id" <*> fields .: "label" <*> optional fields "lastRead" <*> traverse parseJSON (withoutFields ["did", "endpoint", "id", "label", "lastRead"] fields))
instance ToJSON KnowledgeBase where toJSON value = Object (KM.fromList (concat [[("did", toJSON (knowledgeBaseDid value))], [("endpoint", toJSON (knowledgeBaseEndpoint value))], [("id", toJSON (knowledgeBaseId value))], [("label", toJSON (knowledgeBaseLabel value))], optionalPair "lastRead" (knowledgeBaseLastRead value)]) <> fmap toJSON (withoutFields ["did", "endpoint", "id", "label", "lastRead"] (knowledgeBaseAdditionalProperties value)))
