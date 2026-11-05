-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ArchivistEngines
  ( ArchivistEngines(..)
  , ArchivistEnginesActors(..)
  , ArchivistEnginesJobs(..)
  , ArchivistEnginesJobsMark(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Engine
data ArchivistEngines = ArchivistEngines { archivistEnginesActors :: ArchivistEnginesActors, archivistEnginesJobs :: ArchivistEnginesJobs } deriving (Eq, Show)
instance FromJSON ArchivistEngines where
  parseJSON = checked "ArchivistEngines" $ withObject "ArchivistEngines" (\fields -> ArchivistEngines <$> fields .: "actors" <*> fields .: "jobs")
instance ToJSON ArchivistEngines where toJSON value = Object (KM.fromList (concat [[("actors", toJSON (archivistEnginesActors value))], [("jobs", toJSON (archivistEnginesJobs value))]]))

data ArchivistEnginesActors = ArchivistEnginesActors { archivistEnginesActorsGatherer :: Maybe (Engine), archivistEnginesActorsMatcher :: Maybe (Engine) } deriving (Eq, Show)
instance FromJSON ArchivistEnginesActors where
  parseJSON = checked "ArchivistEnginesActors" $ withObject "ArchivistEnginesActors" (\fields -> ArchivistEnginesActors <$> optional fields "gatherer" <*> optional fields "matcher")
instance ToJSON ArchivistEnginesActors where toJSON value = Object (KM.fromList (concat [optionalPair "gatherer" (archivistEnginesActorsGatherer value), optionalPair "matcher" (archivistEnginesActorsMatcher value)]))

data ArchivistEnginesJobs = ArchivistEnginesJobs { archivistEnginesJobsMark :: Maybe (ArchivistEnginesJobsMark), archivistEnginesJobsYield :: Maybe (Engine) } deriving (Eq, Show)
instance FromJSON ArchivistEnginesJobs where
  parseJSON = checked "ArchivistEnginesJobs" $ withObject "ArchivistEnginesJobs" (\fields -> ArchivistEnginesJobs <$> optional fields "mark" <*> optional fields "yield")
instance ToJSON ArchivistEnginesJobs where toJSON value = Object (KM.fromList (concat [optionalPair "mark" (archivistEnginesJobsMark value), optionalPair "yield" (archivistEnginesJobsYield value)]))

data ArchivistEnginesJobsMark = ArchivistEnginesJobsMark { archivistEnginesJobsMarkAssessing :: Maybe (Engine), archivistEnginesJobsMarkCommenting :: Maybe (Engine), archivistEnginesJobsMarkHighlighting :: Maybe (Engine), archivistEnginesJobsMarkLinking :: Maybe (Engine), archivistEnginesJobsMarkTagging :: Maybe (Engine) } deriving (Eq, Show)
instance FromJSON ArchivistEnginesJobsMark where
  parseJSON = checked "ArchivistEnginesJobsMark" $ withObject "ArchivistEnginesJobsMark" (\fields -> ArchivistEnginesJobsMark <$> optional fields "assessing" <*> optional fields "commenting" <*> optional fields "highlighting" <*> optional fields "linking" <*> optional fields "tagging")
instance ToJSON ArchivistEnginesJobsMark where toJSON value = Object (KM.fromList (concat [optionalPair "assessing" (archivistEnginesJobsMarkAssessing value), optionalPair "commenting" (archivistEnginesJobsMarkCommenting value), optionalPair "highlighting" (archivistEnginesJobsMarkHighlighting value), optionalPair "linking" (archivistEnginesJobsMarkLinking value), optionalPair "tagging" (archivistEnginesJobsMarkTagging value)]))

