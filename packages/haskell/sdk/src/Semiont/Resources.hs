module Semiont.Resources (getPrimaryRepresentation, getPrimaryMediaType, getResourceEntityTypes) where

import Data.Text (Text)
import Semiont.Types

getPrimaryRepresentation :: ResourceDescriptor -> Maybe Representation
getPrimaryRepresentation resource = case resourceDescriptorRepresentations resource of
  ResourceDescriptorRepresentationsBranch1 representation -> Just representation
  ResourceDescriptorRepresentationsBranch2 (representation : _) -> Just representation
  ResourceDescriptorRepresentationsBranch2 [] -> Nothing
getPrimaryMediaType :: ResourceDescriptor -> Maybe Text
getPrimaryMediaType = fmap representationMediaType . getPrimaryRepresentation
getResourceEntityTypes :: ResourceDescriptor -> [Text]
getResourceEntityTypes = maybe [] id . resourceDescriptorEntityTypes
