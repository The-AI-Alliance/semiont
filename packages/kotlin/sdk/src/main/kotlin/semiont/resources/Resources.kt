package semiont.resources

import semiont.types.Representation
import semiont.types.ResourceDescriptor
import semiont.types.ResourceDescriptorRepresentations

/*
 * Reading a resource's description (specs/src/resources/reader-cases.json): a
 * resource's representations are one representation or a list of them, and
 * its entity types may be left out. These read each, so that nothing that
 * reads a resource narrows those shapes by hand.
 */

/** A resource's primary representation: its one, or the first of its list. Nothing for a resource with none. */
internal fun primaryRepresentation(resource: ResourceDescriptor): Representation? = when (val stated = resource.representations) {
    is Representation -> stated
    is ResourceDescriptorRepresentations.List -> stated.value.firstOrNull()
}

/** The media type of a resource's primary representation, as it is stated. Nothing for a resource with none. */
internal fun primaryMediaType(resource: ResourceDescriptor): String? = primaryRepresentation(resource)?.mediaType

/** The entity types a resource states, in the order it states them: none for a resource that states none. */
internal fun resourceEntityTypes(resource: ResourceDescriptor): List<String> = resource.entityTypes.orEmpty()
