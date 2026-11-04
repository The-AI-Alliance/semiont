import Foundation
import Synchronization

public struct SearchState<Result: Sendable>: Sendable {
  public let results: [Result]
  public let isSearching: Bool
}

extension SearchState: Encodable where Result: Encodable {}

/// Debounces a query and follows successive answers until the next search starts.
public final class SearchPipeline<Result: Sendable>: StateUnit {
  private struct Work: Sendable {
    var waiting: Task<Void, Never>?
    var following: Task<Void, Never>?
    var debounceGeneration = 0
    var searchGeneration = 0
    var searched: String?
    var disposed = false
  }

  public let query: Watched<String>
  public let state = Watched(SearchState<Result>(results: [], isSearching: false))
  private let work = Mutex(Work())
  private let debounce: Duration
  private let clock: any Clock<Duration>
  private let search: @Sendable (String) -> AsyncStream<[Result]?>

  /// A nil answer means the search is still pending.
  public convenience init(
    initialQuery: String = "", debounce: Duration? = nil,
    search: @escaping @Sendable (String) -> AsyncStream<[Result]?>
  ) {
    self.init(
      initialQuery: initialQuery, debounce: debounce, clock: ContinuousClock(), search: search)
  }

  package init(
    initialQuery: String = "", debounce: Duration? = nil, clock: any Clock<Duration>,
    search: @escaping @Sendable (String) -> AsyncStream<[Result]?>
  ) {
    query = Watched(initialQuery)
    self.debounce = debounce ?? .milliseconds(Timings.searchDebounceMs)
    self.clock = clock
    self.search = search
    work.withLock { wait(&$0) }
  }

  public func setQuery(_ value: String) {
    work.withLock { work in
      guard !work.disposed, value != query.value else { return }
      query.set(value)
      wait(&work)
    }
  }

  private func wait(_ work: inout Work) {
    work.waiting?.cancel()
    work.debounceGeneration += 1
    let generation = work.debounceGeneration
    work.waiting = Task { [weak self, clock, debounce] in
      do {
        try await clock.sleep(for: debounce)
        self?.settled(generation)
      } catch {}
    }
  }

  private func settled(_ generation: Int) {
    work.withLock { work in
      guard !work.disposed, work.debounceGeneration == generation else { return }
      work.waiting = nil
      let current = query.value
      guard work.searched != current else { return }
      work.searched = current
      work.following?.cancel()
      work.following = nil
      work.searchGeneration += 1
      let searchGeneration = work.searchGeneration
      let wanted = current.trimmingCharacters(in: .whitespacesAndNewlines)
      state.set(SearchState(results: [], isSearching: !wanted.isEmpty))
      guard !wanted.isEmpty else { return }
      work.following = Task { [weak self, search] in
        guard !Task.isCancelled else { return }
        for await results in search(wanted) {
          guard !Task.isCancelled else { return }
          self?.received(results, generation: searchGeneration)
        }
      }
    }
  }

  private func received(_ results: [Result]?, generation: Int) {
    work.withLock { work in
      guard !work.disposed, work.searchGeneration == generation else { return }
      state.set(SearchState(results: results ?? [], isSearching: results == nil))
    }
  }

  public func dispose() {
    work.withLock { work in
      guard !work.disposed else { return }
      work.disposed = true
      work.waiting?.cancel()
      work.following?.cancel()
      work.waiting = nil
      work.following = nil
      query.finish()
      state.finish()
    }
  }

  deinit { dispose() }
}
