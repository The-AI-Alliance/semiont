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
  let clock: any Clock<Duration>
  private let lifetime = Lifetime()
  private let disposed = Mutex(false)
  private let keeping: KeptQueries?
  private let live: LiveQueries
  public init(
    transport: any Transport, gateway: (any GatewayOperations)? = nil,
    content: (any ContentTransport)? = nil, followTiming: FollowTiming = FollowTiming(),
    persistence: CachePersistence? = nil, invalidationWindowMs: Int? = nil,
    clock: any Clock<Duration> = ContinuousClock()
  ) async throws {
    self.clock = clock
    let keeping = persistence.map { KeptQueries($0, clock: clock) }
    self.keeping = keeping
    var places: [ResourceId: String]?
    if let keeping, let person = persistence?.person { places = keeping.attach(person) }
    if let http = transport as? HttpTransport, let places { await http.restoreBookmarks(places) }
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
    let live = LiveQueries(
      wire: wire, transport: transport, content: content, lifetime: lifetime, keeping: keeping,
      invalidationWindowMs: invalidationWindowMs ?? Timings.invalidationWindowMs, clock: clock)
    self.live = live
    browse = BrowseNamespace(
      wire: wire, bus: bus, lifetime: lifetime, content: content, live: live)
    gather = GatherNamespace(wire: wire, lifetime: lifetime, live: live)
    match = MatchNamespace(wire: wire, bus: bus, lifetime: lifetime, live: live)
    yield = YieldNamespace(
      wire: wire, bus: bus, lifetime: lifetime, timing: followTiming, clock: clock,
      content: content)
    mark = MarkNamespace(
      wire: wire, bus: bus, lifetime: lifetime, timing: followTiming, clock: clock)
    job = JobNamespace(
      wire: wire, bus: bus, transport: transport, lifetime: lifetime, clock: clock)
    frame = FrameNamespace(wire: wire)
    bind = BindNamespace(wire: wire, bus: bus)
    beckon = BeckonNamespace(wire: wire, bus: bus)
    auth = gateway.map { AuthNamespace(gateway: $0) }
    system = gateway.map { SystemNamespace(gateway: $0) }
    if places != nil { await live.rehydrate() }
    let life = lifetime
    let id = UUID()
    let task = Task {
      defer {
        source.dispose()
        life.forget(id)
      }
      do {
        for try await carried in source {
          if Task.isCancelled { break }
          bus.receive(carried)
          await live.receive(carried)
          if case .frame(let frame) = carried, let id = frame.eventId, let scope = frame.scope {
            keeping?.heard(id, in: scope)
          }
        }
      } catch {
        // The transport's failures are its public error channel; bridge teardown is silent.
      }
    }
    life.keep(task, id: id)
    life.onEnd { source.dispose() }
    let connection = transport.state.observations()
    life.start {
      var seenOpen = false
      var wasOpen = false
      for await state in connection {
        if Task.isCancelled || state == .closed { break }
        let open = state == .open
        if open, seenOpen, !wasOpen {
          await live.reopened()
        }
        seenOpen = seenOpen || open
        wasOpen = open
      }
    }
  }
  public static func fromHttp(
    baseUrl: String, httpClient: HTTPClient, token: String? = nil,
    persistence: CachePersistence? = nil, clock: any Clock<Duration> = ContinuousClock(),
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator()
  )
    async throws -> SemiontClient
  {
    try Task.checkCancellation()
    let transport = HttpTransport(
      baseUrl: baseUrl, httpClient: httpClient, token: token, clock: clock, random: random)
    do {
      return try await SemiontClient(
        transport: transport, gateway: transport, persistence: persistence, clock: clock)
    } catch {
      transport.dispose()
      throw error
    }
  }
  /// Starts keeping what the persisted queries hold for the person `person`, when this client
  /// keeps for no one yet: each query takes what is kept for a key it holds no value for, and the
  /// stream resumes each scope it has no place for from the place kept.
  func attach(_ person: String) async {
    guard let places = keeping?.attach(person) else { return }
    if let http = transport as? HttpTransport { await http.restoreBookmarks(places) }
    await live.rehydrate()
  }
  /// Waits until every write of what this client keeps that has begun has landed, or been dropped:
  /// once it is disposed, until its closing has written what it held.
  func closed() async { await keeping?.closed() }
  /// Forgets the saved sign-in `kept` holds once every write of what this client keeps that has
  /// begun has landed, and so that it writes nothing more: nothing it saves lands after what
  /// forgetting deletes.
  func forgetSignIn(_ kept: any SignInKept) async throws {
    guard let keeping else { return try await kept.forget() }
    try await keeping.forgetting { try await kept.forget() }
  }
  public func dispose() {
    guard
      disposed.withLock({ ended in
        if ended { return false }
        ended = true
        return true
      })
    else { return }
    keeping?.close()
    lifetime.end()
    transport.dispose()
    bus.dispose()
  }
  deinit { dispose() }
}
