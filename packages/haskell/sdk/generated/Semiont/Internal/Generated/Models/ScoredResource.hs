-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ScoredResource
  ( ScoredResource(..)
  , ScoredResourceAbout(..)
  , ScoredResourceConformsTo(..)
  , ScoredResourceGenerator(..)
  , ScoredResourceIdentifier(..)
  , ScoredResourceIdentifierBranch3Value(..)
  , ScoredResourceRepresentations(..)
  , ScoredResourceU40_context(..)
  , ScoredResourceU40_contextBranch2Value(..)
  , ScoredResourceU40_contextBranch3ValueItem(..)
  , ScoredResourceU40_contextBranch3ValueItemBranch2Value(..)
  , ScoredResourceU40_type(..)
  , ScoredResourceWasAttributedTo(..)
  , ScoredResourceWasDerivedFrom(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Agent
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.Representation
import Semiont.Internal.Generated.Models.ResourceId
data ScoredResource = ScoredResource { scoredResourceU40_context :: ScoredResourceU40_context, scoredResourceU40_id :: ResourceId, scoredResourceU40_type :: Maybe (ScoredResourceU40_type), scoredResourceAbout :: Maybe (ScoredResourceAbout), scoredResourceArchived :: Maybe (Bool), scoredResourceAvailableFormats :: Maybe ([Text]), scoredResourceConformsTo :: Maybe (ScoredResourceConformsTo), scoredResourceDateCreated :: Maybe (Text), scoredResourceDateModified :: Maybe (Text), scoredResourceDescription :: Maybe (Text), scoredResourceEntityTypes :: Maybe ([Text]), scoredResourceGenerator :: Maybe (ScoredResourceGenerator), scoredResourceHasPart :: Maybe ([Text]), scoredResourceIdentifier :: Maybe (ScoredResourceIdentifier), scoredResourceIsDraft :: Maybe (Bool), scoredResourceIsPartOf :: Maybe ([Text]), scoredResourceLicense :: Maybe (Text), scoredResourceMatchReason :: Maybe (Text), scoredResourceName :: Text, scoredResourceOriginatedFrom :: Maybe (Text), scoredResourceRepresentations :: ScoredResourceRepresentations, scoredResourceSameAs :: Maybe ([Text]), scoredResourceScore :: Maybe (Scientific), scoredResourceSourceAnnotationId :: Maybe (AnnotationId), scoredResourceSourceResourceId :: Maybe (ResourceId), scoredResourceVersion :: Maybe (Text), scoredResourceWasAttributedTo :: Maybe (ScoredResourceWasAttributedTo), scoredResourceWasDerivedFrom :: Maybe (ScoredResourceWasDerivedFrom), scoredResourceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ScoredResource where
  parseJSON = checked "ScoredResource" $ withObject "ScoredResource" (\fields -> ScoredResource <$> fields .: "@context" <*> fields .: "@id" <*> optional fields "@type" <*> optional fields "about" <*> optional fields "archived" <*> optional fields "availableFormats" <*> optional fields "conformsTo" <*> optional fields "dateCreated" <*> optional fields "dateModified" <*> optional fields "description" <*> optional fields "entityTypes" <*> optional fields "generator" <*> optional fields "hasPart" <*> optional fields "identifier" <*> optional fields "isDraft" <*> optional fields "isPartOf" <*> optional fields "license" <*> optional fields "matchReason" <*> fields .: "name" <*> optional fields "originatedFrom" <*> fields .: "representations" <*> optional fields "sameAs" <*> optional fields "score" <*> optional fields "sourceAnnotationId" <*> optional fields "sourceResourceId" <*> optional fields "version" <*> optional fields "wasAttributedTo" <*> optional fields "wasDerivedFrom" <*> traverse parseJSON (withoutFields ["@context", "@id", "@type", "about", "archived", "availableFormats", "conformsTo", "dateCreated", "dateModified", "description", "entityTypes", "generator", "hasPart", "identifier", "isDraft", "isPartOf", "license", "matchReason", "name", "originatedFrom", "representations", "sameAs", "score", "sourceAnnotationId", "sourceResourceId", "version", "wasAttributedTo", "wasDerivedFrom"] fields))
instance ToJSON ScoredResource where toJSON value = Object (KM.fromList (concat [[("@context", toJSON (scoredResourceU40_context value))], [("@id", toJSON (scoredResourceU40_id value))], optionalPair "@type" (scoredResourceU40_type value), optionalPair "about" (scoredResourceAbout value), optionalPair "archived" (scoredResourceArchived value), optionalPair "availableFormats" (scoredResourceAvailableFormats value), optionalPair "conformsTo" (scoredResourceConformsTo value), optionalPair "dateCreated" (scoredResourceDateCreated value), optionalPair "dateModified" (scoredResourceDateModified value), optionalPair "description" (scoredResourceDescription value), optionalPair "entityTypes" (scoredResourceEntityTypes value), optionalPair "generator" (scoredResourceGenerator value), optionalPair "hasPart" (scoredResourceHasPart value), optionalPair "identifier" (scoredResourceIdentifier value), optionalPair "isDraft" (scoredResourceIsDraft value), optionalPair "isPartOf" (scoredResourceIsPartOf value), optionalPair "license" (scoredResourceLicense value), optionalPair "matchReason" (scoredResourceMatchReason value), [("name", toJSON (scoredResourceName value))], optionalPair "originatedFrom" (scoredResourceOriginatedFrom value), [("representations", toJSON (scoredResourceRepresentations value))], optionalPair "sameAs" (scoredResourceSameAs value), optionalPair "score" (scoredResourceScore value), optionalPair "sourceAnnotationId" (scoredResourceSourceAnnotationId value), optionalPair "sourceResourceId" (scoredResourceSourceResourceId value), optionalPair "version" (scoredResourceVersion value), optionalPair "wasAttributedTo" (scoredResourceWasAttributedTo value), optionalPair "wasDerivedFrom" (scoredResourceWasDerivedFrom value)]) <> fmap toJSON (withoutFields ["@context", "@id", "@type", "about", "archived", "availableFormats", "conformsTo", "dateCreated", "dateModified", "description", "entityTypes", "generator", "hasPart", "identifier", "isDraft", "isPartOf", "license", "matchReason", "name", "originatedFrom", "representations", "sameAs", "score", "sourceAnnotationId", "sourceResourceId", "version", "wasAttributedTo", "wasDerivedFrom"] (scoredResourceAdditionalProperties value)))

data ScoredResourceAbout = ScoredResourceAboutBranch1 (Text) | ScoredResourceAboutBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ScoredResourceAbout where
  parseJSON = checked "ScoredResourceAbout" $ \value -> (ScoredResourceAboutBranch1 <$> parseJSON value) <|> (ScoredResourceAboutBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceAbout where
  toJSON (ScoredResourceAboutBranch1 value) = toJSON value
  toJSON (ScoredResourceAboutBranch2 value) = toJSON value


data ScoredResourceConformsTo = ScoredResourceConformsToBranch1 (Text) | ScoredResourceConformsToBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ScoredResourceConformsTo where
  parseJSON = checked "ScoredResourceConformsTo" $ \value -> (ScoredResourceConformsToBranch1 <$> parseJSON value) <|> (ScoredResourceConformsToBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceConformsTo where
  toJSON (ScoredResourceConformsToBranch1 value) = toJSON value
  toJSON (ScoredResourceConformsToBranch2 value) = toJSON value


data ScoredResourceGenerator = ScoredResourceGeneratorBranch1 (Agent) | ScoredResourceGeneratorBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ScoredResourceGenerator where
  parseJSON = checked "ScoredResourceGenerator" $ \value -> (ScoredResourceGeneratorBranch1 <$> parseJSON value) <|> (ScoredResourceGeneratorBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceGenerator where
  toJSON (ScoredResourceGeneratorBranch1 value) = toJSON value
  toJSON (ScoredResourceGeneratorBranch2 value) = toJSON value


data ScoredResourceIdentifier = ScoredResourceIdentifierBranch1 (Text) | ScoredResourceIdentifierBranch2 ([Text]) | ScoredResourceIdentifierBranch3 (ScoredResourceIdentifierBranch3Value) deriving (Eq, Show)
instance FromJSON ScoredResourceIdentifier where
  parseJSON = checked "ScoredResourceIdentifier" $ \value -> (ScoredResourceIdentifierBranch1 <$> parseJSON value) <|> (ScoredResourceIdentifierBranch2 <$> parseJSON value) <|> (ScoredResourceIdentifierBranch3 <$> parseJSON value)
instance ToJSON ScoredResourceIdentifier where
  toJSON (ScoredResourceIdentifierBranch1 value) = toJSON value
  toJSON (ScoredResourceIdentifierBranch2 value) = toJSON value
  toJSON (ScoredResourceIdentifierBranch3 value) = toJSON value


data ScoredResourceIdentifierBranch3Value = ScoredResourceIdentifierBranch3Value { scoredResourceIdentifierBranch3ValueU40_id :: Maybe (Text), scoredResourceIdentifierBranch3ValueScheme :: Maybe (Text), scoredResourceIdentifierBranch3ValueValue :: Maybe (Text), scoredResourceIdentifierBranch3ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ScoredResourceIdentifierBranch3Value where
  parseJSON = checked "ScoredResourceIdentifierBranch3Value" $ withObject "ScoredResourceIdentifierBranch3Value" (\fields -> ScoredResourceIdentifierBranch3Value <$> optional fields "@id" <*> optional fields "scheme" <*> optional fields "value" <*> traverse parseJSON (withoutFields ["@id", "scheme", "value"] fields))
instance ToJSON ScoredResourceIdentifierBranch3Value where toJSON value = Object (KM.fromList (concat [optionalPair "@id" (scoredResourceIdentifierBranch3ValueU40_id value), optionalPair "scheme" (scoredResourceIdentifierBranch3ValueScheme value), optionalPair "value" (scoredResourceIdentifierBranch3ValueValue value)]) <> fmap toJSON (withoutFields ["@id", "scheme", "value"] (scoredResourceIdentifierBranch3ValueAdditionalProperties value)))

data ScoredResourceRepresentations = ScoredResourceRepresentationsBranch1 (Representation) | ScoredResourceRepresentationsBranch2 ([Representation]) deriving (Eq, Show)
instance FromJSON ScoredResourceRepresentations where
  parseJSON = checked "ScoredResourceRepresentations" $ \value -> (ScoredResourceRepresentationsBranch1 <$> parseJSON value) <|> (ScoredResourceRepresentationsBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceRepresentations where
  toJSON (ScoredResourceRepresentationsBranch1 value) = toJSON value
  toJSON (ScoredResourceRepresentationsBranch2 value) = toJSON value


data ScoredResourceU40_context = ScoredResourceU40_contextBranch1 (Text) | ScoredResourceU40_contextBranch2 (ScoredResourceU40_contextBranch2Value) | ScoredResourceU40_contextBranch3 ([ScoredResourceU40_contextBranch3ValueItem]) deriving (Eq, Show)
instance FromJSON ScoredResourceU40_context where
  parseJSON = checked "ScoredResourceU40_context" $ \value -> (ScoredResourceU40_contextBranch1 <$> parseJSON value) <|> (ScoredResourceU40_contextBranch2 <$> parseJSON value) <|> (ScoredResourceU40_contextBranch3 <$> parseJSON value)
instance ToJSON ScoredResourceU40_context where
  toJSON (ScoredResourceU40_contextBranch1 value) = toJSON value
  toJSON (ScoredResourceU40_contextBranch2 value) = toJSON value
  toJSON (ScoredResourceU40_contextBranch3 value) = toJSON value


data ScoredResourceU40_contextBranch2Value = ScoredResourceU40_contextBranch2Value { scoredResourceU40_contextBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ScoredResourceU40_contextBranch2Value where
  parseJSON = checked "ScoredResourceU40_contextBranch2Value" $ withObject "ScoredResourceU40_contextBranch2Value" (\fields -> ScoredResourceU40_contextBranch2Value <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON ScoredResourceU40_contextBranch2Value where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (scoredResourceU40_contextBranch2ValueAdditionalProperties value)))

data ScoredResourceU40_contextBranch3ValueItem = ScoredResourceU40_contextBranch3ValueItemBranch1 (Text) | ScoredResourceU40_contextBranch3ValueItemBranch2 (ScoredResourceU40_contextBranch3ValueItemBranch2Value) deriving (Eq, Show)
instance FromJSON ScoredResourceU40_contextBranch3ValueItem where
  parseJSON = checked "ScoredResourceU40_contextBranch3ValueItem" $ \value -> (ScoredResourceU40_contextBranch3ValueItemBranch1 <$> parseJSON value) <|> (ScoredResourceU40_contextBranch3ValueItemBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceU40_contextBranch3ValueItem where
  toJSON (ScoredResourceU40_contextBranch3ValueItemBranch1 value) = toJSON value
  toJSON (ScoredResourceU40_contextBranch3ValueItemBranch2 value) = toJSON value


data ScoredResourceU40_contextBranch3ValueItemBranch2Value = ScoredResourceU40_contextBranch3ValueItemBranch2Value { scoredResourceU40_contextBranch3ValueItemBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ScoredResourceU40_contextBranch3ValueItemBranch2Value where
  parseJSON = checked "ScoredResourceU40_contextBranch3ValueItemBranch2Value" $ withObject "ScoredResourceU40_contextBranch3ValueItemBranch2Value" (\fields -> ScoredResourceU40_contextBranch3ValueItemBranch2Value <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON ScoredResourceU40_contextBranch3ValueItemBranch2Value where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (scoredResourceU40_contextBranch3ValueItemBranch2ValueAdditionalProperties value)))

data ScoredResourceU40_type = ScoredResourceU40_typeBranch1 (Text) | ScoredResourceU40_typeBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ScoredResourceU40_type where
  parseJSON = checked "ScoredResourceU40_type" $ \value -> (ScoredResourceU40_typeBranch1 <$> parseJSON value) <|> (ScoredResourceU40_typeBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceU40_type where
  toJSON (ScoredResourceU40_typeBranch1 value) = toJSON value
  toJSON (ScoredResourceU40_typeBranch2 value) = toJSON value


data ScoredResourceWasAttributedTo = ScoredResourceWasAttributedToBranch1 (Agent) | ScoredResourceWasAttributedToBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ScoredResourceWasAttributedTo where
  parseJSON = checked "ScoredResourceWasAttributedTo" $ \value -> (ScoredResourceWasAttributedToBranch1 <$> parseJSON value) <|> (ScoredResourceWasAttributedToBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceWasAttributedTo where
  toJSON (ScoredResourceWasAttributedToBranch1 value) = toJSON value
  toJSON (ScoredResourceWasAttributedToBranch2 value) = toJSON value


data ScoredResourceWasDerivedFrom = ScoredResourceWasDerivedFromBranch1 (ResourceId) | ScoredResourceWasDerivedFromBranch2 ([ResourceId]) deriving (Eq, Show)
instance FromJSON ScoredResourceWasDerivedFrom where
  parseJSON = checked "ScoredResourceWasDerivedFrom" $ \value -> (ScoredResourceWasDerivedFromBranch1 <$> parseJSON value) <|> (ScoredResourceWasDerivedFromBranch2 <$> parseJSON value)
instance ToJSON ScoredResourceWasDerivedFrom where
  toJSON (ScoredResourceWasDerivedFromBranch1 value) = toJSON value
  toJSON (ScoredResourceWasDerivedFromBranch2 value) = toJSON value
