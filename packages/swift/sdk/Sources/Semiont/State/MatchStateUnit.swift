/// Runs locally requested searches and answers under the asker's correlation ID.
public final class MatchStateUnit: StateUnit {
  private let bus: EventBus
  private let match: MatchNamespace
  private let life = Lifetime()

  public init(client: SemiontClient) {
    bus = client.bus
    match = client.match
    let frames = bus.frames(Channels.matchSearchRequested)
    life.onEnd { frames.dispose() }
    life.start { [weak self] in
      do {
        for try await item in frames {
          guard case .delivered(let request) = item else { continue }
          self?.answer(request)
        }
      } catch {}
    }
  }

  private func answer(_ request: Delivered<MatchSearchRequest>) {
    let payload = request.payload
    let id = request.frame.correlationId
    life.start { [weak self, match] in
      do {
        let found = try await match.search(payload).completed()
        self?.emit(Channels.matchSearchResults, found, correlationId: id)
      } catch {
        self?.emit(
          Channels.matchSearchFailed,
          MatchSearchFailed(error: String(describing: error), referenceId: payload.referenceId),
          correlationId: id)
      }
    }
  }

  private func emit<Value>(_ channel: Channel<Value>, _ value: Value, correlationId: String?) {
    life.whileOpen { try? bus.emit(channel, value, correlationId: correlationId) }
  }

  public func dispose() { life.end() }
  deinit { dispose() }
}
