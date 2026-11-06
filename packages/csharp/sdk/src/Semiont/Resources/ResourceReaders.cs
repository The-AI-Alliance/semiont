using Semiont.Types;

namespace Semiont.Resources;

// Reading a resource's description (protocol/specs/src/resources/reader-cases.json): a resource's representations are
// one representation or a list of them, and its entity types may be left out. These read each, so that nothing that
// reads a resource narrows those shapes by hand.
internal static class ResourceReaders
{
    /// <summary>A resource's primary representation: its one, or the first of its list. Null for a resource with
    /// none.</summary>
    internal static Representation? PrimaryRepresentation(ResourceDescriptor resource) => resource.Representations switch
    {
        ResourceDescriptorRepresentations.RepresentationCase(var only) => only,
        ResourceDescriptorRepresentations.ArrayCase(var listed) => listed.FirstOrDefault(),
    };

    /// <summary>The media type of a resource's primary representation, as it is stated. Null for a resource with
    /// none.</summary>
    internal static string? PrimaryMediaType(ResourceDescriptor resource) => PrimaryRepresentation(resource)?.MediaType;

    /// <summary>The entity types a resource states, in the order it states them: none for a resource that states
    /// none.</summary>
    internal static IReadOnlyList<string> ResourceEntityTypes(ResourceDescriptor resource) => resource.EntityTypes is { } stated ? stated : [];
}
