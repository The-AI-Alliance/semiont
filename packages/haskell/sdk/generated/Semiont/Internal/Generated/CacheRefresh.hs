-- Generated from client/refresh.json. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CacheRefresh (Query(..), ResourceValue, AnnotationsValue, AnnotationValue, EventsValue, ReferencedByValue, ResourcesValue, MatchedResourcesValue, EntityTypesValue, TagSchemasValue, EnginesValue, Reach(..), Ways(..), Row(..), rows, channels, reopened, unreadable) where
import Data.Text (Text)
import Semiont.Internal.Generated.Models.Annotation (Annotation)
import Semiont.Internal.Generated.Models.AttributedEvent (AttributedEvent)
import Semiont.Internal.Generated.Models.EngineEntry (EngineEntry)
import Semiont.Internal.Generated.Models.GetAnnotationsResponse (GetAnnotationsResponse)
import Semiont.Internal.Generated.Models.GetReferencedByResponseReferencedByItem (GetReferencedByResponseReferencedByItem)
import Semiont.Internal.Generated.Models.ListResourcesResponse (ListResourcesResponse)
import Semiont.Internal.Generated.Models.MatchResourcesResponse (MatchResourcesResponse)
import Semiont.Internal.Generated.Models.ResourceDescriptor (ResourceDescriptor)
import Semiont.Internal.Generated.Models.TagSchema (TagSchema)
data Query = Resource | Annotations | Annotation | Events | ReferencedBy | Resources | MatchedResources | EntityTypes | TagSchemas | Engines deriving (Eq, Ord, Show, Enum, Bounded)
-- | The type of the value each live query's cache holds for a key: the table's `value`, a component or a member
-- within one.
type ResourceValue = ResourceDescriptor
type AnnotationsValue = GetAnnotationsResponse
type AnnotationValue = Annotation
type EventsValue = [AttributedEvent]
type ReferencedByValue = [GetReferencedByResponseReferencedByItem]
type ResourcesValue = ListResourcesResponse
type MatchedResourcesValue = MatchResourcesResponse
type EntityTypesValue = [Text]
type TagSchemasValue = [TagSchema]
type EnginesValue = [EngineEntry]
data Reach = Subject | Held deriving (Eq, Show)
-- | Where in its event a row finds the resource it names, the annotation it names, and the value it carries.
data Ways = Ways (Maybe [Text]) (Maybe [Text]) (Maybe [Text]) deriving (Eq, Show)
data Row = Row Text (Maybe Text) Reach Ways [Query] [Query] [Query] deriving (Eq, Show)
rows :: [Row]
rows = [Row "reopened" Nothing Held (Ways Nothing Nothing Nothing) [Resources, MatchedResources, Resource, EntityTypes, TagSchemas, Engines] [] [], Row "unreadable" Nothing Held (Ways Nothing Nothing Nothing) [Resource, Annotations, Annotation, Events, ReferencedBy, Resources, MatchedResources, EntityTypes, TagSchemas, Engines] [] [], Row "bus:resume-gap" Nothing Subject (Ways (Just ["scope"]) Nothing Nothing) [Annotations, Annotation, Resource, Events, ReferencedBy] [] [], Row "mark:added" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Annotations, Events] [] [], Row "mark:removed" Nothing Subject (Ways (Just ["resourceId"]) (Just ["payload", "annotationId"]) Nothing) [Annotations, Events] [] [Annotation], Row "mark:delete-ok" Nothing Subject (Ways Nothing (Just ["response", "annotationId"]) Nothing) [] [] [Annotation], Row "mark:body-updated" (Just "enriched") Subject (Ways (Just ["resourceId"]) (Just ["annotation", "id"]) (Just ["annotation"])) [Events] [Annotations, Annotation] [], Row "mark:body-updated" (Just "unenriched") Subject (Ways (Just ["resourceId"]) (Just ["payload", "annotationId"]) Nothing) [Annotations, Annotation, Events] [] [], Row "mark:entity-tag-added" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Annotations, Resource, Events] [] [], Row "mark:entity-tag-removed" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Annotations, Resource, Events] [] [], Row "mark:archived" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "mark:unarchived" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "yield:created" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "yield:updated" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "yield:cloned" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "yield:moved" Nothing Subject (Ways (Just ["resourceId"]) Nothing Nothing) [Resource, Resources, MatchedResources] [] [], Row "frame:entity-type-added" Nothing Subject (Ways Nothing Nothing Nothing) [EntityTypes] [] [], Row "frame:tag-schema-added" Nothing Subject (Ways Nothing Nothing Nothing) [TagSchemas] [] []]
-- | The triggers that are channels of the bus.
channels :: [Text]
channels = ["bus:resume-gap", "mark:added", "mark:removed", "mark:delete-ok", "mark:body-updated", "mark:entity-tag-added", "mark:entity-tag-removed", "mark:archived", "mark:unarchived", "yield:created", "yield:updated", "yield:cloned", "yield:moved", "frame:entity-type-added", "frame:tag-schema-added"]
reopened, unreadable :: Text
reopened = "reopened"
unreadable = "unreadable"
