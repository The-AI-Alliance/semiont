import Foundation
import SemiontTesting
import Testing

@testable import Semiont

@Test func readmeExamplesMatchAndRun() async throws {
  let examplesFile = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("ReadmeExamples.swift")
  let source = try String(contentsOf: examplesFile, encoding: .utf8)
  let readme = try String(
    contentsOf: Spec.repository.appendingPathComponent("packages/swift/sdk/README.md"),
    encoding: .utf8)
  let examples = try source.components(separatedBy: "// README examples begin\n").dropFirst()
    .map { snippet in
      let end = try #require(snippet.range(of: "\n// README examples end"))
      return String(snippet[..<end.lowerBound])
    }
  let blocks = readme.components(separatedBy: "```swift\n").dropFirst().compactMap { block in
    block.range(of: "\n```").map { range in String(block[..<range.lowerBound]) }
  }
  #expect(!examples.isEmpty)
  #expect(blocks == examples)

  let table = try Spec.read("client/state-units.json").object
  let context = try decoded(
    GatheredContext.self, required(required(table, "fixtures").object, "context"))
  let resource: ResourceDescriptor
  switch context.focus {
  case .resource(let focus): resource = focus.resource
  case .annotation: throw SpecFailure.shape("Expected a resource focus in the shared fixture")
  }
  let invalidTarget = KbTarget(
    endpoint: .httpEndpoint(HttpEndpoint(host: "bad host", port: 4000, protocol: .http)),
    id: "local", label: "Local")
  await #expect(throws: SignInError.self) {
    try await readFirstResource(resource.id, in: invalidTarget) { _ in
      Issue.record("An invalid endpoint produced a device code")
    }
  }

  let job = try JobId("job-1")
  let transport = ScriptedTransport { operation, _ in
    switch operation {
    case Channels.browseResourceRequested.name:
      try wirePayload(
        BrowseResourceResult(
          response: BrowseResourceResultResponse(lastSequence: 0, resource: resource)))
    case Channels.gatherResourceRequested.name:
      try wirePayload(GatherResourceComplete(resourceId: resource.id, response: context))
    case Channels.jobCreate.name:
      try wirePayload(JobCreatedResult(response: JobCreatedResultResponse(jobId: job)))
    default: throw SpecFailure.shape("Unexpected README operation \(operation)")
    }
  }
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }
  let observation = Watched(false)
  let watching = Task {
    await watchResource(resource.id, using: client) { state in
      if case .ready(let read) = state, read.id == resource.id { observation.set(true) }
    }
  }
  defer { watching.cancel() }
  try await within(testDeadlineMs) { for await shown in observation where shown { break } }

  let running = Task { try await generate(from: resource.id, using: client) }
  defer { running.cancel() }
  let completed = try await within(testDeadlineMs) {
    while !transport.attempts.contains(where: { $0.operation == Channels.jobCreate.name }) {
      try await Task.sleep(for: .milliseconds(2))
    }
    let completion = YieldJobCompleteCommand(jobId: job, resourceId: resource.id)
    transport.deliver(
      ReceivedFrame(channel: Channels.jobComplete.name, payload: try wirePayload(completion)))
    return try await running.value
  }
  #expect(completed.jobId == job)
}
