-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceDescriptor
  ( ResourceDescriptor(..)
  , ResourceDescriptorAbout(..)
  , ResourceDescriptorConformsTo(..)
  , ResourceDescriptorGenerator(..)
  , ResourceDescriptorIdentifier(..)
  , ResourceDescriptorIdentifierBranch3Value(..)
  , ResourceDescriptorRepresentations(..)
  , ResourceDescriptorU40_context(..)
  , ResourceDescriptorU40_contextBranch2Value(..)
  , ResourceDescriptorU40_contextBranch3ValueItem(..)
  , ResourceDescriptorU40_contextBranch3ValueItemBranch2Value(..)
  , ResourceDescriptorU40_type(..)
  , ResourceDescriptorWasAttributedTo(..)
  , ResourceDescriptorWasDerivedFrom(..)
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
data ResourceDescriptor = ResourceDescriptor { resourceDescriptorU40_context :: ResourceDescriptorU40_context, resourceDescriptorU40_id :: ResourceId, resourceDescriptorU40_type :: Maybe (ResourceDescriptorU40_type), resourceDescriptorAbout :: Maybe (ResourceDescriptorAbout), resourceDescriptorArchived :: Maybe (Bool), resourceDescriptorAvailableFormats :: Maybe ([Text]), resourceDescriptorConformsTo :: Maybe (ResourceDescriptorConformsTo), resourceDescriptorDateCreated :: Maybe (Text), resourceDescriptorDateModified :: Maybe (Text), resourceDescriptorDescription :: Maybe (Text), resourceDescriptorEntityTypes :: Maybe ([Text]), resourceDescriptorGenerator :: Maybe (ResourceDescriptorGenerator), resourceDescriptorHasPart :: Maybe ([Text]), resourceDescriptorIdentifier :: Maybe (ResourceDescriptorIdentifier), resourceDescriptorIsDraft :: Maybe (Bool), resourceDescriptorIsPartOf :: Maybe ([Text]), resourceDescriptorLicense :: Maybe (Text), resourceDescriptorName :: Text, resourceDescriptorOriginatedFrom :: Maybe (Text), resourceDescriptorRepresentations :: ResourceDescriptorRepresentations, resourceDescriptorSameAs :: Maybe ([Text]), resourceDescriptorSourceAnnotationId :: Maybe (AnnotationId), resourceDescriptorSourceResourceId :: Maybe (ResourceId), resourceDescriptorVersion :: Maybe (Text), resourceDescriptorWasAttributedTo :: Maybe (ResourceDescriptorWasAttributedTo), resourceDescriptorWasDerivedFrom :: Maybe (ResourceDescriptorWasDerivedFrom), resourceDescriptorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceDescriptor where
  parseJSON = checked "ResourceDescriptor" $ withObject "ResourceDescriptor" (\fields -> ResourceDescriptor <$> fields .: "@context" <*> fields .: "@id" <*> optional fields "@type" <*> optional fields "about" <*> optional fields "archived" <*> optional fields "availableFormats" <*> optional fields "conformsTo" <*> optional fields "dateCreated" <*> optional fields "dateModified" <*> optional fields "description" <*> optional fields "entityTypes" <*> optional fields "generator" <*> optional fields "hasPart" <*> optional fields "identifier" <*> optional fields "isDraft" <*> optional fields "isPartOf" <*> optional fields "license" <*> fields .: "name" <*> optional fields "originatedFrom" <*> fields .: "representations" <*> optional fields "sameAs" <*> optional fields "sourceAnnotationId" <*> optional fields "sourceResourceId" <*> optional fields "version" <*> optional fields "wasAttributedTo" <*> optional fields "wasDerivedFrom" <*> traverse parseJSON (withoutFields ["@context", "@id", "@type", "about", "archived", "availableFormats", "conformsTo", "dateCreated", "dateModified", "description", "entityTypes", "generator", "hasPart", "identifier", "isDraft", "isPartOf", "license", "name", "originatedFrom", "representations", "sameAs", "sourceAnnotationId", "sourceResourceId", "version", "wasAttributedTo", "wasDerivedFrom"] fields))
instance ToJSON ResourceDescriptor where toJSON value = Object (KM.fromList (concat [[("@context", toJSON (resourceDescriptorU40_context value))], [("@id", toJSON (resourceDescriptorU40_id value))], optionalPair "@type" (resourceDescriptorU40_type value), optionalPair "about" (resourceDescriptorAbout value), optionalPair "archived" (resourceDescriptorArchived value), optionalPair "availableFormats" (resourceDescriptorAvailableFormats value), optionalPair "conformsTo" (resourceDescriptorConformsTo value), optionalPair "dateCreated" (resourceDescriptorDateCreated value), optionalPair "dateModified" (resourceDescriptorDateModified value), optionalPair "description" (resourceDescriptorDescription value), optionalPair "entityTypes" (resourceDescriptorEntityTypes value), optionalPair "generator" (resourceDescriptorGenerator value), optionalPair "hasPart" (resourceDescriptorHasPart value), optionalPair "identifier" (resourceDescriptorIdentifier value), optionalPair "isDraft" (resourceDescriptorIsDraft value), optionalPair "isPartOf" (resourceDescriptorIsPartOf value), optionalPair "license" (resourceDescriptorLicense value), [("name", toJSON (resourceDescriptorName value))], optionalPair "originatedFrom" (resourceDescriptorOriginatedFrom value), [("representations", toJSON (resourceDescriptorRepresentations value))], optionalPair "sameAs" (resourceDescriptorSameAs value), optionalPair "sourceAnnotationId" (resourceDescriptorSourceAnnotationId value), optionalPair "sourceResourceId" (resourceDescriptorSourceResourceId value), optionalPair "version" (resourceDescriptorVersion value), optionalPair "wasAttributedTo" (resourceDescriptorWasAttributedTo value), optionalPair "wasDerivedFrom" (resourceDescriptorWasDerivedFrom value)]) <> fmap toJSON (withoutFields ["@context", "@id", "@type", "about", "archived", "availableFormats", "conformsTo", "dateCreated", "dateModified", "description", "entityTypes", "generator", "hasPart", "identifier", "isDraft", "isPartOf", "license", "name", "originatedFrom", "representations", "sameAs", "sourceAnnotationId", "sourceResourceId", "version", "wasAttributedTo", "wasDerivedFrom"] (resourceDescriptorAdditionalProperties value)))

data ResourceDescriptorAbout = ResourceDescriptorAboutBranch1 (Text) | ResourceDescriptorAboutBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorAbout where
  parseJSON = checked "ResourceDescriptorAbout" $ \value -> (ResourceDescriptorAboutBranch1 <$> parseJSON value) <|> (ResourceDescriptorAboutBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorAbout where
  toJSON (ResourceDescriptorAboutBranch1 value) = toJSON value
  toJSON (ResourceDescriptorAboutBranch2 value) = toJSON value


data ResourceDescriptorConformsTo = ResourceDescriptorConformsToBranch1 (Text) | ResourceDescriptorConformsToBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorConformsTo where
  parseJSON = checked "ResourceDescriptorConformsTo" $ \value -> (ResourceDescriptorConformsToBranch1 <$> parseJSON value) <|> (ResourceDescriptorConformsToBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorConformsTo where
  toJSON (ResourceDescriptorConformsToBranch1 value) = toJSON value
  toJSON (ResourceDescriptorConformsToBranch2 value) = toJSON value


data ResourceDescriptorGenerator = ResourceDescriptorGeneratorBranch1 (Agent) | ResourceDescriptorGeneratorBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorGenerator where
  parseJSON = checked "ResourceDescriptorGenerator" $ \value -> (ResourceDescriptorGeneratorBranch1 <$> parseJSON value) <|> (ResourceDescriptorGeneratorBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorGenerator where
  toJSON (ResourceDescriptorGeneratorBranch1 value) = toJSON value
  toJSON (ResourceDescriptorGeneratorBranch2 value) = toJSON value


data ResourceDescriptorIdentifier = ResourceDescriptorIdentifierBranch1 (Text) | ResourceDescriptorIdentifierBranch2 ([Text]) | ResourceDescriptorIdentifierBranch3 (ResourceDescriptorIdentifierBranch3Value) deriving (Eq, Show)
instance FromJSON ResourceDescriptorIdentifier where
  parseJSON = checked "ResourceDescriptorIdentifier" $ \value -> (ResourceDescriptorIdentifierBranch1 <$> parseJSON value) <|> (ResourceDescriptorIdentifierBranch2 <$> parseJSON value) <|> (ResourceDescriptorIdentifierBranch3 <$> parseJSON value)
instance ToJSON ResourceDescriptorIdentifier where
  toJSON (ResourceDescriptorIdentifierBranch1 value) = toJSON value
  toJSON (ResourceDescriptorIdentifierBranch2 value) = toJSON value
  toJSON (ResourceDescriptorIdentifierBranch3 value) = toJSON value


data ResourceDescriptorIdentifierBranch3Value = ResourceDescriptorIdentifierBranch3Value { resourceDescriptorIdentifierBranch3ValueU40_id :: Maybe (Text), resourceDescriptorIdentifierBranch3ValueScheme :: Maybe (Text), resourceDescriptorIdentifierBranch3ValueValue :: Maybe (Text), resourceDescriptorIdentifierBranch3ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceDescriptorIdentifierBranch3Value where
  parseJSON = checked "ResourceDescriptorIdentifierBranch3Value" $ withObject "ResourceDescriptorIdentifierBranch3Value" (\fields -> ResourceDescriptorIdentifierBranch3Value <$> optional fields "@id" <*> optional fields "scheme" <*> optional fields "value" <*> traverse parseJSON (withoutFields ["@id", "scheme", "value"] fields))
instance ToJSON ResourceDescriptorIdentifierBranch3Value where toJSON value = Object (KM.fromList (concat [optionalPair "@id" (resourceDescriptorIdentifierBranch3ValueU40_id value), optionalPair "scheme" (resourceDescriptorIdentifierBranch3ValueScheme value), optionalPair "value" (resourceDescriptorIdentifierBranch3ValueValue value)]) <> fmap toJSON (withoutFields ["@id", "scheme", "value"] (resourceDescriptorIdentifierBranch3ValueAdditionalProperties value)))

data ResourceDescriptorRepresentations = ResourceDescriptorRepresentationsBranch1 (Representation) | ResourceDescriptorRepresentationsBranch2 ([Representation]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorRepresentations where
  parseJSON = checked "ResourceDescriptorRepresentations" $ \value -> (ResourceDescriptorRepresentationsBranch1 <$> parseJSON value) <|> (ResourceDescriptorRepresentationsBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorRepresentations where
  toJSON (ResourceDescriptorRepresentationsBranch1 value) = toJSON value
  toJSON (ResourceDescriptorRepresentationsBranch2 value) = toJSON value


data ResourceDescriptorU40_context = ResourceDescriptorU40_contextBranch1 (Text) | ResourceDescriptorU40_contextBranch2 (ResourceDescriptorU40_contextBranch2Value) | ResourceDescriptorU40_contextBranch3 ([ResourceDescriptorU40_contextBranch3ValueItem]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorU40_context where
  parseJSON = checked "ResourceDescriptorU40_context" $ \value -> (ResourceDescriptorU40_contextBranch1 <$> parseJSON value) <|> (ResourceDescriptorU40_contextBranch2 <$> parseJSON value) <|> (ResourceDescriptorU40_contextBranch3 <$> parseJSON value)
instance ToJSON ResourceDescriptorU40_context where
  toJSON (ResourceDescriptorU40_contextBranch1 value) = toJSON value
  toJSON (ResourceDescriptorU40_contextBranch2 value) = toJSON value
  toJSON (ResourceDescriptorU40_contextBranch3 value) = toJSON value


data ResourceDescriptorU40_contextBranch2Value = ResourceDescriptorU40_contextBranch2Value { resourceDescriptorU40_contextBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceDescriptorU40_contextBranch2Value where
  parseJSON = checked "ResourceDescriptorU40_contextBranch2Value" $ withObject "ResourceDescriptorU40_contextBranch2Value" (\fields -> ResourceDescriptorU40_contextBranch2Value <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON ResourceDescriptorU40_contextBranch2Value where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (resourceDescriptorU40_contextBranch2ValueAdditionalProperties value)))

data ResourceDescriptorU40_contextBranch3ValueItem = ResourceDescriptorU40_contextBranch3ValueItemBranch1 (Text) | ResourceDescriptorU40_contextBranch3ValueItemBranch2 (ResourceDescriptorU40_contextBranch3ValueItemBranch2Value) deriving (Eq, Show)
instance FromJSON ResourceDescriptorU40_contextBranch3ValueItem where
  parseJSON = checked "ResourceDescriptorU40_contextBranch3ValueItem" $ \value -> (ResourceDescriptorU40_contextBranch3ValueItemBranch1 <$> parseJSON value) <|> (ResourceDescriptorU40_contextBranch3ValueItemBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorU40_contextBranch3ValueItem where
  toJSON (ResourceDescriptorU40_contextBranch3ValueItemBranch1 value) = toJSON value
  toJSON (ResourceDescriptorU40_contextBranch3ValueItemBranch2 value) = toJSON value


data ResourceDescriptorU40_contextBranch3ValueItemBranch2Value = ResourceDescriptorU40_contextBranch3ValueItemBranch2Value { resourceDescriptorU40_contextBranch3ValueItemBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceDescriptorU40_contextBranch3ValueItemBranch2Value where
  parseJSON = checked "ResourceDescriptorU40_contextBranch3ValueItemBranch2Value" $ withObject "ResourceDescriptorU40_contextBranch3ValueItemBranch2Value" (\fields -> ResourceDescriptorU40_contextBranch3ValueItemBranch2Value <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON ResourceDescriptorU40_contextBranch3ValueItemBranch2Value where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (resourceDescriptorU40_contextBranch3ValueItemBranch2ValueAdditionalProperties value)))

data ResourceDescriptorU40_type = ResourceDescriptorU40_typeBranch1 (Text) | ResourceDescriptorU40_typeBranch2 ([Text]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorU40_type where
  parseJSON = checked "ResourceDescriptorU40_type" $ \value -> (ResourceDescriptorU40_typeBranch1 <$> parseJSON value) <|> (ResourceDescriptorU40_typeBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorU40_type where
  toJSON (ResourceDescriptorU40_typeBranch1 value) = toJSON value
  toJSON (ResourceDescriptorU40_typeBranch2 value) = toJSON value


data ResourceDescriptorWasAttributedTo = ResourceDescriptorWasAttributedToBranch1 (Agent) | ResourceDescriptorWasAttributedToBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorWasAttributedTo where
  parseJSON = checked "ResourceDescriptorWasAttributedTo" $ \value -> (ResourceDescriptorWasAttributedToBranch1 <$> parseJSON value) <|> (ResourceDescriptorWasAttributedToBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorWasAttributedTo where
  toJSON (ResourceDescriptorWasAttributedToBranch1 value) = toJSON value
  toJSON (ResourceDescriptorWasAttributedToBranch2 value) = toJSON value


data ResourceDescriptorWasDerivedFrom = ResourceDescriptorWasDerivedFromBranch1 (ResourceId) | ResourceDescriptorWasDerivedFromBranch2 ([ResourceId]) deriving (Eq, Show)
instance FromJSON ResourceDescriptorWasDerivedFrom where
  parseJSON = checked "ResourceDescriptorWasDerivedFrom" $ \value -> (ResourceDescriptorWasDerivedFromBranch1 <$> parseJSON value) <|> (ResourceDescriptorWasDerivedFromBranch2 <$> parseJSON value)
instance ToJSON ResourceDescriptorWasDerivedFrom where
  toJSON (ResourceDescriptorWasDerivedFromBranch1 value) = toJSON value
  toJSON (ResourceDescriptorWasDerivedFromBranch2 value) = toJSON value


