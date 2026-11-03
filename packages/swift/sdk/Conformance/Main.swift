import AsyncHTTPClient
import Foundation
import Semiont

private struct Misuse: Error, CustomStringConvertible { let description: String }
extension Dictionary where Key == String, Value == JSONValue {
  fileprivate func text(_ key: String) throws -> String {
    guard case .string(let value) = self[key] else {
      throw Misuse(description: "\(key) must be text")
    }
    return value
  }
  fileprivate func optionalText(_ key: String) throws -> String? {
    guard self[key] != nil else { return nil }
    return try text(key)
  }
  fileprivate func integer(_ key: String) throws -> Int {
    guard case .number(let n) = self[key], n.rounded() == n, n >= Double(Int.min),
      n < Double(Int.max)
    else { throw Misuse(description: "\(key) must be a whole number") }
    return Int(n)
  }
  fileprivate func optionalBool(_ key: String) throws -> Bool? {
    guard let value = self[key] else { return nil }
    guard case .bool(let flag) = value else { throw Misuse(description: "\(key) must be boolean") }
    return flag
  }
  fileprivate func object(_ key: String) throws -> [String: JSONValue] {
    guard case .object(let value) = self[key] else {
      throw Misuse(description: "\(key) must be an object")
    }
    return value
  }
  fileprivate func texts(_ key: String) throws -> [String] {
    guard case .array(let values) = self[key] else {
      throw Misuse(description: "\(key) must be a list")
    }
    return try values.map { value in
      guard case .string(let text) = value else {
        throw Misuse(description: "\(key) contains non-text")
      }
      return text
    }
  }
}
private func encoded<Value: Encodable>(_ value: Value) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}
private actor Output {
  func say(_ object: [String: JSONValue]) {
    do {
      var data = try JSONEncoder().encode(object)
      data.append(10)
      FileHandle.standardOutput.write(data)
    } catch { FileHandle.standardError.write(Data("Cannot encode driver output: \(error)\n".utf8)) }
  }
}
private func failure(_ error: any Error) -> JSONValue {
  var fields: [String: JSONValue] = ["detail": .string(String(describing: error))]
  if let error = error as? TransportError {
    fields["code"] = .string(error.code)
    if let status = error.status { fields["status"] = .number(Double(status)) }
  } else if let error = error as? BusRequestError {
    fields["code"] = .string(error.code)
  }
  return .object(fields)
}
private actor Renewals {
  private var tokens: [String]
  init(_ tokens: [String]) { self.tokens = tokens }
  func next() -> String? { tokens.isEmpty ? nil : tokens.removeFirst() }
}
private actor Driver {
  let output: Output
  let flush: @Sendable () async -> Void
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  var transport: HttpTransport?
  var tasks: [Int: Task<Void, Never>] = [:]
  var abandoned: Set<Int> = []
  var reporters: [Task<Void, Never>] = []
  var holds: [String: [ResourceHold]] = [:]
  init(output: Output, flush: @escaping @Sendable () async -> Void) {
    self.output = output
    self.flush = flush
  }
  func accept(_ args: [String: JSONValue]) async {
    let id: Int
    let op: String
    do {
      id = try args.integer("id")
      op = try args.text("op")
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      return
    }
    let supported: Set<String> = [
      "open", "close", "set-token", "listen", "subscribe-resource", "release-resource", "emit",
      "request", "abandon", "put", "upload", "get", "get-stream", "graph", "annotations",
      "anchored-text", "health", "status", "current-user", "media-token",
      "protected-resource-metadata", "sync",
    ]
    guard supported.contains(op) else {
      await output.say(["id": .number(Double(id)), "unsupported": .bool(true)])
      return
    }
    let immediate: Set<String> = [
      "open", "close", "set-token", "listen", "subscribe-resource", "release-resource", "abandon",
      "sync",
    ]
    if immediate.contains(op) {
      do {
        let value = try await run(op, args: args, id: id)
        await complete(id, value: value)
      } catch { await complete(id, error: error) }
    } else {
      tasks[id] = Task {
        do {
          let value = try await self.run(op, args: args, id: id)
          await self.complete(id, value: value)
        } catch { await self.complete(id, error: error) }
      }
    }
  }
  func complete(_ id: Int, value: JSONValue) async {
    tasks.removeValue(forKey: id)
    if abandoned.remove(id) != nil {
      await output.say(["id": .number(Double(id)), "abandoned": .bool(true)])
    } else {
      await output.say(["id": .number(Double(id)), "ok": value])
    }
  }
  func complete(_ id: Int, error: any Error) async {
    tasks.removeValue(forKey: id)
    if abandoned.remove(id) != nil {
      await output.say(["id": .number(Double(id)), "abandoned": .bool(true)])
    } else if let misuse = error as? Misuse {
      await output.say(["id": .number(Double(id)), "misuse": .string(misuse.description)])
    } else {
      await output.say(["id": .number(Double(id)), "error": failure(error)])
    }
  }
  func current() throws -> HttpTransport {
    guard let transport else { throw Misuse(description: "No transport is open") }
    return transport
  }
  func run(_ op: String, args: [String: JSONValue], id: Int) async throws -> JSONValue {
    switch op {
    case "open":
      guard transport == nil else { throw Misuse(description: "A transport is already open") }
      var timing = TransportTiming()
      if args["timing"] != nil {
        let values = try args.object("timing")
        for key in values.keys {
          switch key {
          case "reconnectMs": timing.reconnectMs = try values.integer(key)
          case "lazyRemoveMs": timing.lazyRemoveMs = try values.integer(key)
          case "lingerMs": timing.lingerMs = try values.integer(key)
          case "seenEventIdsCount": timing.seenEventIdsCount = try values.integer(key)
          case "emitRetry":
            let budget = try values.object(key)
            timing.emitAttempts = try budget.integer("attempts")
            timing.emitInitialDelayMs = try budget.integer("initialDelayMs")
            timing.emitMaxDelayMs = try budget.integer("maxDelayMs")
          default: throw Misuse(description: "Unknown timing override \(key)")
          }
        }
      }
      let refresh: (@Sendable (String?) async throws -> String?)?
      if args["renewals"] != nil {
        let renewals = Renewals(try args.texts("renewals"))
        refresh = { _ in await renewals.next() }
      } else {
        refresh = nil
      }
      let client = HttpTransport(
        baseUrl: try args.text("baseUrl"), httpClient: http, token: try args.text("token"),
        channels: try args.texts("channels"), timing: timing, refresher: refresh)
      transport = client
      let errors = client.failures()
      let output = self.output
      reporters.append(
        Task {
          for await state in client.state { await output.say(["state": .string(state.rawValue)]) }
        })
      reporters.append(
        Task {
          do { for try await error in errors { await output.say(["error": failure(error)]) } } catch
          {}
        })
      return .null
    case "close":
      try current().dispose()
      await flush()
      return .null
    case "set-token":
      try await current().setToken(args.text("token"))
      return .null
    case "listen":
      let channel = try args.text("channel")
      let frames = try await current().frames(channel)
      let output = self.output
      reporters.append(
        Task {
          do {
            for try await frame in frames {
              guard case .object(var fields) = try encoded(frame) else {
                throw Misuse(description: "A frame must encode as an object")
              }
              fields.removeValue(forKey: "trace")
              await output.say(["frame": .object(fields)])
            }
          } catch {}
        })
      return .null
    case "subscribe-resource":
      let resource = try args.text("resource")
      let hold = try await current().subscribeToResource(ResourceId(resource))
      holds[resource, default: []].append(hold)
      return .null
    case "release-resource":
      let resource = try args.text("resource")
      guard let hold = holds[resource]?.popLast() else {
        throw Misuse(description: "No hold on \(resource)")
      }
      hold.dispose()
      return .null
    case "abandon":
      let target = try args.integer("request")
      guard let task = tasks[target], !abandoned.contains(target) else {
        throw Misuse(description: "No such unsettled operation")
      }
      abandoned.insert(target)
      task.cancel()
      return .null
    case "emit":
      let count = try await current().emit(
        channel: args.text("channel"), payload: args.object("payload"),
        scope: args.optionalText("scope").map(ResourceId.init),
        correlationId: args.optionalText("correlationId"))
      return count.map { .object(["subscribers": .number(Double($0))]) } ?? .object([:])
    case "request":
      let response = try await current().request(
        operation: args.text("operation"), payload: args.object("payload"),
        timeoutMs: args.integer("timeoutMs"))
      return .object(response["response"].map { ["response": $0] } ?? [:])
    case "health": return try await encoded(current().healthCheck())
    case "status": return try await encoded(current().getStatus())
    case "current-user": return try await encoded(current().getCurrentUser())
    case "protected-resource-metadata":
      return try await encoded(current().getProtectedResourceMetadata())
    case "media-token":
      return try await encoded(current().getMediaToken(ResourceId(args.text("resource"))))
    case "graph":
      return try await encoded(current().getResourceGraph(ResourceId(args.text("resource"))))
    case "annotations":
      return try await encoded(current().getAnnotations(ResourceId(args.text("resource"))))
    case "anchored-text":
      return try await encoded(current().getAnchoredText(ResourceId(args.text("resource"))))
    case "get", "get-stream":
      let client = try current()
      let resource = try ResourceId(args.text("resource"))
      let bytes: Data
      let contentType: String
      if op == "get" {
        let read = try await client.getBinary(resource)
        bytes = read.bytes
        contentType = read.contentType
      } else {
        let read = try await client.getBinaryStream(resource)
        defer { read.dispose() }
        var data = Data()
        for try await chunk in read { data.append(chunk) }
        bytes = data
        contentType = read.contentType
      }
      return .object([
        "contentType": .string(contentType), "bytes": .string(bytes.base64EncodedString()),
      ])
    case "put", "upload":
      guard let data = Data(base64Encoded: try args.text("bytes")) else {
        throw Misuse(description: "bytes is not base64")
      }
      let request = PutBinaryRequest(
        name: try args.text("name"), file: data, format: try args.text("format"),
        storageUri: try args.text("storageUri"),
        entityTypes: args["entityTypes"] == nil ? [] : try args.texts("entityTypes"),
        language: try args.optionalText("language"),
        sourceAnnotationId: try args.optionalText("sourceAnnotationId").map(AnnotationId.init),
        sourceResourceId: try args.optionalText("sourceResourceId").map(ResourceId.init),
        generationPrompt: try args.optionalText("generationPrompt"),
        jobId: try args.optionalText("jobId").map(JobId.init),
        isDraft: try args.optionalBool("isDraft"), cloneToken: try args.optionalText("cloneToken"),
        archiveOriginal: try args.optionalBool("archiveOriginal"))
      let upload = try current().putBinary(request)
      defer { upload.dispose() }
      let progress: Task<Void, Never>?
      if op == "upload" {
        let output = self.output
        progress = Task {
          do {
            for try await report in upload {
              await output.say([
                "progress": .object([
                  "upload": .number(Double(id)),
                  "bytesUploaded": .number(Double(report.bytesUploaded)),
                  "totalBytes": .number(Double(report.totalBytes)),
                ])
              ])
            }
          } catch {}
        }
      } else {
        progress = nil
      }
      do {
        let response = try await upload.completed()
        if let progress { await progress.value }
        return try encoded(response)
      } catch {
        progress?.cancel()
        throw error
      }
    case "sync": return .null
    default: throw Misuse(description: "Unknown operation \(op)")
    }
  }
  func finish() async {
    transport?.dispose()
    let pending = Array(tasks.values)
    for task in pending { task.cancel() }
    for task in pending { await task.value }
    for reporter in reporters { reporter.cancel() }
    for reporter in reporters { await reporter.value }
    try? await http.shutdown()
  }
}

@main
struct WireDriver {
  static func main() async {
    let telemetry = DriverTelemetry(
      endpoint: ProcessInfo.processInfo.environment["OTEL_EXPORTER_OTLP_ENDPOINT"])
    let output = Output()
    let driver = Driver(output: output, flush: { await telemetry?.flush() })
    await output.say(["ready": .bool(true)])
    while let line = readLine() {
      do {
        let args = try JSONDecoder().decode([String: JSONValue].self, from: Data(line.utf8))
        await driver.accept(args)
      } catch { FileHandle.standardError.write(Data("Invalid driver input: \(error)\n".utf8)) }
    }
    await driver.finish()
    telemetry?.finish()
  }
}
