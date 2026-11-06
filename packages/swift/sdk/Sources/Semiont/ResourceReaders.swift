import Foundation

// Reading a resource's description (protocol/specs/src/resources/reader-cases.json): a resource's
// representations are one representation or a list of them, and its entity types may be left out.
// These read each, so that nothing that reads a resource narrows those shapes by hand.

/// A resource's primary representation: its one, or the first of its list. Nil for a resource
/// with none.
func primaryRepresentation(_ resource: ResourceDescriptor) -> Representation? {
  switch resource.representations {
  case .representation(let only): only
  case .list(let listed): listed.first
  }
}

/// The media type of a resource's primary representation, as it is stated. Nil for a resource
/// with none.
func primaryMediaType(_ resource: ResourceDescriptor) -> String? {
  primaryRepresentation(resource)?.mediaType
}

/// The entity types a resource states, in the order it states them: none for a resource that
/// states none.
func resourceEntityTypes(_ resource: ResourceDescriptor) -> [String] {
  guard let stated = resource.entityTypes else { return [] }
  return stated
}
