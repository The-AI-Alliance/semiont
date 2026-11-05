-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Representation
  ( Representation(..)
  , RepresentationConformsTo(..)
  , RepresentationRel(..)
  , RepresentationU40_type(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data Representation = Representation { representationU40_id :: Maybe (Text), representationU40_type :: Maybe (RepresentationU40_type), representationByteSize :: Maybe (Integer), representationChecksum :: Maybe (Text), representationConformsTo :: Maybe (RepresentationConformsTo), representationCreated :: Maybe (Text), representationDuration :: Maybe (Scientific), representationEncoding :: Maybe (Text), representationFilename :: Maybe (Text), representationHeight :: Maybe (Integer), representationLanguage :: Maybe (Text), representationMediaType :: Text, representationModified :: Maybe (Text), representationRel :: Maybe (RepresentationRel), representationStorageUri :: Maybe (Text), representationTags :: Maybe ([Text]), representationWidth :: Maybe (Integer), representationAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON Representation where
  parseJSON = checked "Representation" $ withObject "Representation" (\fields -> Representation <$> optional fields "@id" <*> optional fields "@type" <*> optional fields "byteSize" <*> optional fields "checksum" <*> optional fields "conformsTo" <*> optional fields "created" <*> optional fields "duration" <*> optional fields "encoding" <*> optional fields "filename" <*> optional fields "height" <*> optional fields "language" <*> fields .: "mediaType" <*> optional fields "modified" <*> optional fields "rel" <*> optional fields "storageUri" <*> optional fields "tags" <*> optional fields "width" <*> traverse parseJSON (withoutFields ["@id", "@type", "byteSize", "checksum", "conformsTo", "created", "duration", "encoding", "filename", "height", "language", "mediaType", "modified", "rel", "storageUri", "tags", "width"] fields))
instance ToJSON Representation where toJSON value = Object (KM.fromList (concat [optionalPair "@id" (representationU40_id value), optionalPair "@type" (representationU40_type value), optionalPair "byteSize" (representationByteSize value), optionalPair "checksum" (representationChecksum value), optionalPair "conformsTo" (representationConformsTo value), optionalPair "created" (representationCreated value), optionalPair "duration" (representationDuration value), optionalPair "encoding" (representationEncoding value), optionalPair "filename" (representationFilename value), optionalPair "height" (representationHeight value), optionalPair "language" (representationLanguage value), [("mediaType", toJSON (representationMediaType value))], optionalPair "modified" (representationModified value), optionalPair "rel" (representationRel value), optionalPair "storageUri" (representationStorageUri value), optionalPair "tags" (representationTags value), optionalPair "width" (representationWidth value)]) <> fmap toJSON (withoutFields ["@id", "@type", "byteSize", "checksum", "conformsTo", "created", "duration", "encoding", "filename", "height", "language", "mediaType", "modified", "rel", "storageUri", "tags", "width"] (representationAdditionalProperties value)))

data RepresentationConformsTo = RepresentationConformsToBranch1 (Text) | RepresentationConformsToBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON RepresentationConformsTo where
  parseJSON = checked "RepresentationConformsTo" $ \value -> (RepresentationConformsToBranch1 <$> parseJSON value) <|> (RepresentationConformsToBranch2 <$> parseJSON value)
instance ToJSON RepresentationConformsTo where
  toJSON (RepresentationConformsToBranch1 value) = toJSON value
  toJSON (RepresentationConformsToBranch2 value) = toJSON value


data RepresentationRel = RepresentationRelOriginal | RepresentationRelThumbnail | RepresentationRelPreview | RepresentationRelOptimized | RepresentationRelDerived | RepresentationRelOther deriving (Eq, Show)
instance FromJSON RepresentationRel where
  parseJSON = checked "RepresentationRel" $ \value -> if value == (String "original") then pure RepresentationRelOriginal else if value == (String "thumbnail") then pure RepresentationRelThumbnail else if value == (String "preview") then pure RepresentationRelPreview else if value == (String "optimized") then pure RepresentationRelOptimized else if value == (String "derived") then pure RepresentationRelDerived else if value == (String "other") then pure RepresentationRelOther else fail "unknown enumeration member"
instance ToJSON RepresentationRel where
  toJSON RepresentationRelOriginal = String "original"
  toJSON RepresentationRelThumbnail = String "thumbnail"
  toJSON RepresentationRelPreview = String "preview"
  toJSON RepresentationRelOptimized = String "optimized"
  toJSON RepresentationRelDerived = String "derived"
  toJSON RepresentationRelOther = String "other"


data RepresentationU40_type = RepresentationU40_typeBranch1 (Text) | RepresentationU40_typeBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON RepresentationU40_type where
  parseJSON = checked "RepresentationU40_type" $ \value -> (RepresentationU40_typeBranch1 <$> parseJSON value) <|> (RepresentationU40_typeBranch2 <$> parseJSON value)
instance ToJSON RepresentationU40_type where
  toJSON (RepresentationU40_typeBranch1 value) = toJSON value
  toJSON (RepresentationU40_typeBranch2 value) = toJSON value


