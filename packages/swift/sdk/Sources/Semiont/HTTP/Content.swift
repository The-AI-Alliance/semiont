import AsyncHTTPClient
import Foundation
import NIOCore
import OpenTelemetryApi
import Synchronization

/// The multipart form as callers supply it. Its member census is held to ResourceUpload by a test.
public struct PutBinaryRequest: Sendable {
  public let name: String
  public let file: Data
  public let format: String
  public let storageUri: String
  public var entityTypes: [String]
  public var language: String?
  public var sourceAnnotationId: AnnotationId?
  public var sourceResourceId: ResourceId?
  public var generationPrompt: String?
  public var generator: [Agent]
  public var jobId: JobId?
  public var isDraft: Bool?
  public var cloneToken: String?
  public var archiveOriginal: Bool?
  public init(
    name: String, file: Data, format: String, storageUri: String, entityTypes: [String] = [],
    language: String? = nil,
    sourceAnnotationId: AnnotationId? = nil, sourceResourceId: ResourceId? = nil,
    generationPrompt: String? = nil,
    generator: [Agent] = [], jobId: JobId? = nil, isDraft: Bool? = nil, cloneToken: String? = nil,
    archiveOriginal: Bool? = nil
  ) {
    self.name = name
    self.file = file
    self.format = format
    self.storageUri = storageUri
    self.entityTypes = entityTypes
    self.language = language
    self.sourceAnnotationId = sourceAnnotationId
    self.sourceResourceId = sourceResourceId
    self.generationPrompt = generationPrompt
    self.generator = generator
    self.jobId = jobId
    self.isDraft = isDraft
    self.cloneToken = cloneToken
    self.archiveOriginal = archiveOriginal
  }
}
public struct UploadProgress: Sendable {
  public let bytesUploaded: Int
  public let totalBytes: Int
}
public final class Upload: AsyncSequence, Sendable {
  public typealias Element = UploadProgress
  public typealias AsyncIterator = Events<UploadProgress>.AsyncIterator
  private let progress: Events<UploadProgress>
  private let task: Task<CreateResourceResponse, any Error>
  init(task: Task<CreateResourceResponse, any Error>, progress: Events<UploadProgress>) {
    self.task = task
    self.progress = progress
  }
  public func makeAsyncIterator() -> AsyncIterator { progress.makeAsyncIterator() }
  public func completed() async throws -> CreateResourceResponse {
    try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }
  public func dispose() {
    task.cancel()
    progress.dispose()
  }
}
public struct Content: Sendable {
  public let contentType: String
  public let bytes: Data
}
public final class ContentStream: AsyncSequence, Sendable {
  public typealias Element = Data
  public typealias AsyncIterator = Events<Data>.AsyncIterator
  public let contentType: String
  private let bytes: Events<Data>
  private let task: Task<Void, Never>
  init(
    response: HTTPClientResponse, lifetime: Lifetime,
    onEnd: @escaping @Sendable () async -> Void = {}
  ) throws {
    guard let contentType = response.headers.first(name: "Content-Type") else {
      throw TransportError(.error, "Content response has no Content-Type")
    }
    self.contentType = contentType
    let (demands, demand) = AsyncStream<Void>.makeStream(bufferingPolicy: .unbounded)
    let (stream, continuation) = AsyncThrowingStream<Data, any Error>.makeStream(
      bufferingPolicy: .unbounded)
    let id = UUID()
    let task = Task {
      defer {
        lifetime.forget(id)
        demand.finish()
      }
      var failure: (any Error)?
      do {
        var source = response.body.makeAsyncIterator()
        for await _ in demands {
          guard let buffer = try await source.next() else { break }
          continuation.yield(Data(buffer.readableBytesView))
        }
      } catch { failure = error }
      await onEnd()
      continuation.finish(throwing: failure)
    }
    self.task = task
    lifetime.keep(task, id: id)
    bytes = Events(
      stream, demand: { demand.yield(()) },
      stop: {
        demand.finish()
        task.cancel()
        continuation.finish()
      })
  }
  public func makeAsyncIterator() -> AsyncIterator { bytes.makeAsyncIterator() }
  public func dispose() {
    task.cancel()
    bytes.dispose()
  }
}

private struct Multipart: Sendable {
  let boundary = "semiont-" + UUID().uuidString
  let data: Data
  init(_ request: PutBinaryRequest) throws {
    guard !request.format.contains("\r"), !request.format.contains("\n") else {
      throw TransportError(.error, "Invalid multipart content type")
    }
    func json<Value: Encodable>(_ value: Value) throws -> String {
      String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }
    let form = ResourceUpload(
      archiveOriginal: request.archiveOriginal.map(String.init), cloneToken: request.cloneToken,
      entityTypes: request.entityTypes.isEmpty ? nil : try json(request.entityTypes), file: "",
      format: request.format,
      generationPrompt: request.generationPrompt,
      generator: request.generator.isEmpty ? nil : try json(request.generator),
      isDraft: request.isDraft.map(String.init), jobId: request.jobId, language: request.language,
      name: request.name,
      sourceAnnotationId: request.sourceAnnotationId, sourceResourceId: request.sourceResourceId,
      storageUri: request.storageUri)
    let fields = try JSONDecoder().decode(
      [String: JSONValue].self, from: JSONEncoder().encode(form))
    var data = Data()
    for name in fields.keys.sorted() where name != "file" {
      guard case .string(let value) = fields[name] else {
        throw TransportError(.error, "Multipart field \(name) is not text")
      }
      data.append(
        Data(
          "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(quoted(name))\"\r\n\r\n\(value)\r\n"
            .utf8))
    }
    data.append(
      Data(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(quoted(request.name))\"\r\nContent-Type: \(request.format)\r\n\r\n"
          .utf8))
    data.append(request.file)
    data.append(Data("\r\n--\(boundary)--\r\n".utf8))
    self.data = data
  }
}
private func quoted(_ value: String) -> String {
  value.replacingOccurrences(of: "\"", with: "%22").replacingOccurrences(of: "\r", with: "%0D")
    .replacingOccurrences(of: "\n", with: "%0A")
}
private struct UploadBytes: AsyncSequence, Sendable {
  typealias Element = ByteBuffer
  let data: Data
  let report: @Sendable (Int) -> Void
  struct AsyncIterator: AsyncIteratorProtocol {
    let data: Data
    let report: @Sendable (Int) -> Void
    var offset = 0
    mutating func next() async throws -> ByteBuffer? {
      try Task.checkCancellation()
      guard offset < data.count else { return nil }
      let end = Swift.min(offset + 64 * 1024, data.count)
      let chunk = ByteBuffer(bytes: data[offset..<end])
      offset = end
      report(offset)
      return chunk
    }
  }
  func makeAsyncIterator() -> AsyncIterator { AsyncIterator(data: data, report: report) }
}
extension HttpTransport {
  public nonisolated func putBinary(_ request: PutBinaryRequest) -> Upload {
    let (stream, continuation) = AsyncThrowingStream<UploadProgress, any Error>.makeStream(
      bufferingPolicy: .unbounded)
    let life = lifetime
    let id = UUID()
    let task = Task {
      defer {
        continuation.finish()
        life.forget(id)
      }
      return try await self.sendUpload(request, progress: continuation)
    }
    life.keep(task, id: id)
    return Upload(
      task: task,
      progress: Events(
        stream,
        stop: {
          task.cancel()
          continuation.finish()
        }))
  }
  private func sendUpload(
    _ request: PutBinaryRequest,
    progress: AsyncThrowingStream<UploadProgress, any Error>.Continuation
  ) async throws -> CreateResourceResponse {
    let upload = transportSpan(
      .contentPut,
      attributes: [
        "content.format": .string(request.format), "content.size_bytes": .int(request.file.count),
      ])
    defer { upload.end() }
    let form = try Multipart(request)
    let http = self.http
    let highWater = Mutex(-1)
    let report: @Sendable (Int) -> Void = { sent in
      let newer = highWater.withLock { previous in
        if sent <= previous { return false }
        previous = sent
        return true
      }
      if newer { progress.yield(UploadProgress(bytesUploaded: sent, totalBytes: form.data.count)) }
    }
    BusLog.line(
      "PUT", channel: "content",
      payload: [
        "name": .string(request.name), "format": .string(request.format),
        "storageUri": .string(request.storageUri), "sizeBytes": .number(Double(request.file.count)),
      ], scope: nil, correlationID: nil)
    var credential = token
    var renewed = false
    while true {
      try Task.checkCancellation()
      if lifetime.ended { throw CancellationError() }
      var wire = HTTPClientRequest(url: baseUrl + "/resources")
      wire.method = .POST
      for (key, value) in traceCarrier(upload) { wire.headers.add(name: key, value: value) }
      wire.headers.add(
        name: "Content-Type", value: "multipart/form-data; boundary=" + form.boundary)
      if let credential { wire.headers.add(name: "Authorization", value: "Bearer " + credential) }
      wire.body = .stream(
        UploadBytes(data: form.data, report: report), length: .known(Int64(form.data.count)))
      do {
        let response = try await http.execute(wire, deadline: .distantFuture)
        if !(200..<300).contains(Int(response.status.code)) {
          let failure = await Self.refusal(
            response, path: "/resources", deadlineMs: timing.httpRequestMs)
          if failure.reason == .unauthorized, !renewed {
            renewed = true
            if let newToken = try await renew(refused: credential) {
              credential = newToken
              continue
            }
          }
          throw failure
        }
        var data = Data()
        for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
        return try JSONDecoder().decode(CreateResourceResponse.self, from: data)
      } catch {
        if Task.isCancelled || lifetime.ended { throw CancellationError() }
        let failure =
          (error as? TransportError) ?? TransportError(.error, "Upload failed: \(error)")
        failureEvents.yield(failure)
        throw failure
      }
    }
  }
  public func getBinaryStream(_ resource: ResourceId) async throws -> ContentStream {
    try await owned { owner in
      let read = StreamingReadTrace(resource)
      do {
        BusLog.line(
          "GET", channel: "content", payload: ["resourceId": .string(resource.value)], scope: nil,
          correlationID: nil)
        let exchange = try await owner.begin(
          method: "GET", path: "/resources/" + resource.value, trace: read.headers())
        return try ContentStream(
          response: exchange.response, lifetime: owner.lifetime, onEnd: { await read.end() })
      } catch {
        await read.end()
        throw error
      }
    }
  }
  public func getBinary(_ resource: ResourceId) async throws -> Content {
    try await owned { owner in
      let read = transportSpan(.contentGet, attributes: ["resource.id": .string(resource.value)])
      defer { read.end() }
      BusLog.line(
        "GET", channel: "content", payload: ["resourceId": .string(resource.value)], scope: nil,
        correlationID: nil)
      let exchange = try await owner.begin(
        method: "GET", path: "/resources/" + resource.value, trace: traceCarrier(read))
      do {
        let stream = try ContentStream(response: exchange.response, lifetime: owner.lifetime)
        defer { stream.dispose() }
        return try await within(until: exchange.deadline) {
          var data = Data()
          for try await chunk in stream { data.append(chunk) }
          return Content(contentType: stream.contentType, bytes: data)
        }
      } catch {
        if Task.isCancelled || owner.lifetime.ended { throw CancellationError() }
        let failure = TransportError(
          .unavailable, "GET /resources/\(resource.value) could not finish: \(error)")
        owner.failureEvents.yield(failure)
        throw failure
      }
    }
  }
  public func getResourceGraph(_ resource: ResourceId) async throws -> GetResourceResponse {
    let read = transportSpan(
      .contentGet_graph, attributes: ["resource.id": .string(resource.value)])
    defer { read.end() }
    return try await answer(
      GetResourceResponse.self, path: "/resources/\(resource.value)/jsonld",
      trace: traceCarrier(read))
  }
  public func getAnnotations(_ resource: ResourceId) async throws -> GetAnnotationsResponse {
    let read = transportSpan(
      .contentGet_annotations, attributes: ["resource.id": .string(resource.value)])
    defer { read.end() }
    return try await answer(
      GetAnnotationsResponse.self, path: "/resources/\(resource.value)/annotations",
      trace: traceCarrier(read))
  }
  public func getAnchoredText(_ resource: ResourceId) async throws -> AnchoredTextAnswer {
    let read = transportSpan(
      .contentGet_anchored_text, attributes: ["resource.id": .string(resource.value)])
    defer { read.end() }
    return try await answer(
      AnchoredTextAnswer.self, path: "/resources/\(resource.value)/anchored-text",
      trace: traceCarrier(read))
  }
}
