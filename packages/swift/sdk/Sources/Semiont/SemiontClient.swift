import AsyncHTTPClient
import Foundation
import Synchronization

public final class SemiontClient: Sendable {
  public let transport: any Transport
  public let bus: EventBus
  public let wire: Bus
  public let browse: BrowseNamespace
  public let gather: GatherNamespace
  public let match: MatchNamespace
  public let yield: YieldNamespace
  public let mark: MarkNamespace
  public let job: JobNamespace
  public let frame: FrameNamespace
  public let bind: BindNamespace
  public let beckon: BeckonNamespace
  public let auth: AuthNamespace?
  public let system: SystemNamespace?
  public var state: Watched<ConnectionState> { transport.state }
  public var baseUrl: String { transport.baseUrl }
  private let lifetime = Lifetime()
  private let disposed = Mutex(false)
  public init(
    transport: any Transport, gateway: (any GatewayOperations)? = nil,
    content: (any ContentTransport)? = nil, followTiming: FollowTiming = FollowTiming()
  ) async throws {
    let source = try await transport.frames([])
    do { try Task.checkCancellation() } catch {
      source.dispose()
      throw error
    }
    self.transport = transport
    let bus = EventBus()
    self.bus = bus
    let wire = Bus(transport)
    self.wire = wire
    let content = content ?? (transport as? any ContentTransport)
    browse = BrowseNamespace(wire: wire, bus: bus, lifetime: lifetime, content: content)
    gather = GatherNamespace(wire: wire, lifetime: lifetime)
    match = MatchNamespace(wire: wire, bus: bus, lifetime: lifetime)
    yield = YieldNamespace(
      wire: wire, bus: bus, lifetime: lifetime, timing: followTiming, content: content)
    mark = MarkNamespace(wire: wire, bus: bus, lifetime: lifetime, timing: followTiming)
    job = JobNamespace(wire: wire, bus: bus)
    frame = FrameNamespace(wire: wire)
    bind = BindNamespace(wire: wire, bus: bus)
    beckon = BeckonNamespace(wire: wire, bus: bus)
    auth = gateway.map { AuthNamespace(gateway: $0) }
    system = gateway.map { SystemNamespace(gateway: $0) }
    let life = lifetime
    let id = UUID()
    let task = Task {
      defer {
        source.dispose()
        life.forget(id)
      }
      do {
        for try await frame in source {
          if Task.isCancelled { break }
          bus.receive(frame)
        }
      } catch {
        // The transport's failures are its public error channel; bridge teardown is silent.
      }
    }
    life.keep(task, id: id)
    life.onEnd { source.dispose() }
  }
  public static func fromHttp(baseUrl: String, httpClient: HTTPClient, token: String? = nil)
    async throws -> SemiontClient
  {
    try Task.checkCancellation()
    let transport = HttpTransport(baseUrl: baseUrl, httpClient: httpClient, token: token)
    do { return try await SemiontClient(transport: transport, gateway: transport) } catch {
      transport.dispose()
      throw error
    }
  }
  public func dispose() {
    guard
      disposed.withLock({ ended in
        if ended { return false }
        ended = true
        return true
      })
    else { return }
    lifetime.end()
    transport.dispose()
    bus.dispose()
  }
  deinit { dispose() }
}
