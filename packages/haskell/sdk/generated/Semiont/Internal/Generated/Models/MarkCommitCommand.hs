-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkCommitCommand
  ( MarkCommitCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data MarkCommitCommand = MarkCommitCommand { markCommitCommandU5f_roles :: Maybe ([Text]), markCommitCommandU5f_userId :: Maybe (UserId), markCommitCommandAnnotations :: [Annotation], markCommitCommandJobId :: Maybe (JobId), markCommitCommandResourceId :: ResourceId, markCommitCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkCommitCommand where
  parseJSON = checked "MarkCommitCommand" $ withObject "MarkCommitCommand" (\fields -> MarkCommitCommand <$> optional fields "_roles" <*> optional fields "_userId" <*> fields .: "annotations" <*> optional fields "jobId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["_roles", "_userId", "annotations", "jobId", "resourceId"] fields))
instance ToJSON MarkCommitCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_roles" (markCommitCommandU5f_roles value), optionalPair "_userId" (markCommitCommandU5f_userId value), [("annotations", toJSON (markCommitCommandAnnotations value))], optionalPair "jobId" (markCommitCommandJobId value), [("resourceId", toJSON (markCommitCommandResourceId value))]]) <> fmap toJSON (withoutFields ["_roles", "_userId", "annotations", "jobId", "resourceId"] (markCommitCommandAdditionalProperties value)))

