-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BodyPurpose
  ( BodyPurpose(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BodyPurpose = BodyPurposeAssessing | BodyPurposeBookmarking | BodyPurposeClassifying | BodyPurposeCommenting | BodyPurposeDescribing | BodyPurposeEditing | BodyPurposeHighlighting | BodyPurposeIdentifying | BodyPurposeLinking | BodyPurposeModerating | BodyPurposeQuestioning | BodyPurposeReplying | BodyPurposeTagging deriving (Eq, Show)
instance FromJSON BodyPurpose where
  parseJSON = checked "BodyPurpose" $ \value -> if value == (String "assessing") then pure BodyPurposeAssessing else if value == (String "bookmarking") then pure BodyPurposeBookmarking else if value == (String "classifying") then pure BodyPurposeClassifying else if value == (String "commenting") then pure BodyPurposeCommenting else if value == (String "describing") then pure BodyPurposeDescribing else if value == (String "editing") then pure BodyPurposeEditing else if value == (String "highlighting") then pure BodyPurposeHighlighting else if value == (String "identifying") then pure BodyPurposeIdentifying else if value == (String "linking") then pure BodyPurposeLinking else if value == (String "moderating") then pure BodyPurposeModerating else if value == (String "questioning") then pure BodyPurposeQuestioning else if value == (String "replying") then pure BodyPurposeReplying else if value == (String "tagging") then pure BodyPurposeTagging else fail "unknown enumeration member"
instance ToJSON BodyPurpose where
  toJSON BodyPurposeAssessing = String "assessing"
  toJSON BodyPurposeBookmarking = String "bookmarking"
  toJSON BodyPurposeClassifying = String "classifying"
  toJSON BodyPurposeCommenting = String "commenting"
  toJSON BodyPurposeDescribing = String "describing"
  toJSON BodyPurposeEditing = String "editing"
  toJSON BodyPurposeHighlighting = String "highlighting"
  toJSON BodyPurposeIdentifying = String "identifying"
  toJSON BodyPurposeLinking = String "linking"
  toJSON BodyPurposeModerating = String "moderating"
  toJSON BodyPurposeQuestioning = String "questioning"
  toJSON BodyPurposeReplying = String "replying"
  toJSON BodyPurposeTagging = String "tagging"
