/// The SDK's one spawn point: every task the SDK starts is started here, and prefers the executor
/// bound for its caller. An application binds none, and each task runs as a plain `Task` would; a
/// test binds one thread, which runs a case's work in the order it was made ready.
package enum Spawning {
  /// The executor every task spawned in this task's scope prefers.
  @TaskLocal package static var executor: (any TaskExecutor)?

  /// Whether the running task prefers the bound executor, as every task spawned here does: false
  /// for a task started past `spawn` while one is bound, which a plain `Task` copies the binding
  /// into and not the preference.
  package static var onBoundExecutor: Bool {
    guard let executor else { return true }
    return withUnsafeCurrentTask { $0?.unownedTaskExecutor } == executor.asUnownedTaskExecutor()
  }
}

@discardableResult
package func spawn<Success: Sendable>(
  _ operation: sending @escaping () async -> Success
) -> Task<Success, Never> {
  Task(executorPreference: Spawning.executor, operation: operation)
}

@discardableResult
package func spawn<Success: Sendable>(
  _ operation: sending @escaping () async throws -> Success
) -> Task<Success, any Error> {
  Task(executorPreference: Spawning.executor, operation: operation)
}

/// An actor's work: the task hops onto `actor` and runs `operation` isolated to it.
@discardableResult
package func spawn<A: Actor, Success: Sendable>(
  on actor: A, _ operation: @escaping @Sendable (isolated A) async -> Success
) -> Task<Success, Never> {
  Task(executorPreference: Spawning.executor) { await operation(actor) }
}

/// An actor's work: the task hops onto `actor` and runs `operation` isolated to it.
@discardableResult
package func spawn<A: Actor, Success: Sendable>(
  on actor: A, _ operation: @escaping @Sendable (isolated A) async throws -> Success
) -> Task<Success, any Error> {
  Task(executorPreference: Spawning.executor) { try await operation(actor) }
}

/// A task that takes nothing of its caller's, its priority and task-locals among them, but the
/// executor bound for it.
package func spawnDetached<Success: Sendable>(
  _ operation: sending @escaping () async throws -> Success
) -> Task<Success, any Error> {
  Task.detached(executorPreference: Spawning.executor, operation: operation)
}
