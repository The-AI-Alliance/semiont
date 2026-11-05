-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SessionLeftEvent
  ( SessionLeftEvent(..)
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
data SessionLeftEvent = SessionLeftEvent { sessionLeftEventConnectionId :: Text, sessionLeftEventParticipant :: UserId, sessionLeftEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SessionLeftEvent where
  parseJSON = checked "SessionLeftEvent" $ withObject "SessionLeftEvent" (\fields -> SessionLeftEvent <$> fields .: "connectionId" <*> fields .: "participant" <*> traverse parseJSON (withoutFields ["connectionId", "participant"] fields))
instance ToJSON SessionLeftEvent where toJSON value = Object (KM.fromList (concat [[("connectionId", toJSON (sessionLeftEventConnectionId value))], [("participant", toJSON (sessionLeftEventParticipant value))]]) <> fmap toJSON (withoutFields ["connectionId", "participant"] (sessionLeftEventAdditionalProperties value)))
