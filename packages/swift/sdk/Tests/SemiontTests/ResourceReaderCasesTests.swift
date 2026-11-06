import Foundation
import Testing

@testable import Semiont

// The readers of a resource's description, held to protocol/specs/src/resources/reader-cases.json,
// the table every SDK's readers run. Each resource is held to the table of what its schema
// requires before it is decoded: a refused case is refused there, for the fault it states.

private let readMembers: Set<String> = [
  "why", "resource", "entityTypes", "primaryRepresentation", "primaryMediaType",
]
private let refusedMembers: Set<String> = ["why", "resource", "refused", "member", "reason"]

private func readerCases() throws -> [[String: JSONValue]] {
  try required(Spec.read("resources/reader-cases.json").object, "cases").array.map { try $0.object }
}

private func statedFault(_ row: [String: JSONValue]) throws -> Fault {
  let reason = try required(row, "reason").text
  return Fault(
    member: try required(row, "member").text,
    reason: try #require(FrameRefusalReason(rawValue: reason), "no reason is \(reason)"))
}

@Test func everyReaderGivesWhatTheTableSaysAndEveryRefusedResourceHasItsStatedFault() throws {
  var one = 0
  var several = 0
  var none = 0
  var reasons: Set<FrameRefusalReason> = []
  for row in try readerCases() {
    let why = try required(row, "why").text
    let resource = try required(row, "resource")
    if row["refused"] == .bool(true) {
      #expect(Set(row.keys) == refusedMembers, "\(why)")
      let fault = try statedFault(row)
      reasons.insert(fault.reason)
      #expect(faultOf("ResourceDescriptor", resource) == fault, "\(why)")
      continue
    }
    #expect(Set(row.keys).isSubset(of: readMembers), "\(why)")
    #expect(faultOf("ResourceDescriptor", resource) == nil, "\(why)")
    let descriptor = try decoded(ResourceDescriptor.self, resource)
    switch descriptor.representations {
    case .representation: one += 1
    case .list(let listed): if listed.isEmpty { none += 1 } else { several += 1 }
    }
    #expect(try primaryRepresentation(descriptor).map(encoded) == row["primaryRepresentation"], "\(why)")
    #expect(primaryMediaType(descriptor).map(JSONValue.string) == row["primaryMediaType"], "\(why)")
    #expect(
      JSONValue.array(resourceEntityTypes(descriptor).map(JSONValue.string))
        == (try required(row, "entityTypes")), "\(why)")
  }
  #expect(one > 0 && several > 0 && none > 0)
  #expect(reasons == [.lacks, .malformed])
}

@Test func aReplyWhoseResourceLacksAMemberIsRefusedForThatFaultInEverySDKsWords() async throws {
  // A member a resource lacks is one Swift's decoder cannot make a ResourceDescriptor without, so a
  // reply carrying it is refused as it is decoded, and named by the walk.
  for row in try readerCases() where row["refused"] == .bool(true) {
    let fault = try statedFault(row)
    guard fault.reason == .lacks else { continue }
    let resource = try required(row, "resource")
    let probe = ProbeTransport()
    probe.handle { _, _ in
      ["response": .object(["resource": resource, "lastSequence": .number(1)])]
    }
    do {
      _ = try await Bus(probe).request(
        Operations.browseResourceRequested,
        BrowseResourceRequest(resourceId: ResourceId("res-refused")))
      Issue.record("\(try required(row, "why").text): the reply was read")
    } catch let error as TransportError {
      #expect(error.reason == .error)
      #expect(
        error.description
          == "a payload on browse:resource-result is not that channel's: it has no `response.resource.\(fault.member)`"
      )
    }
  }
}
