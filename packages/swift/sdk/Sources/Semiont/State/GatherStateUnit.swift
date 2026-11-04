/// Holds the two independent gathers that a resource viewer can ask for.
public final class GatherStateUnit: StateUnit {
  private struct Gathering: Sendable {
    let context = Watched<GatheredContext?>(nil)
    let loading = Watched(false)
    let error = Watched<(any Error)?>(nil)

    func begin() {
      loading.set(true)
      error.set(nil)
      context.set(nil)
    }

    func finish() {
      context.finish()
      loading.finish()
      error.finish()
    }
  }

  private let annotation = Gathering()
  private let resource = Gathering()
  public let annotationId = Watched<AnnotationId?>(nil)
  public var context: Watched<GatheredContext?> { annotation.context }
  public var loading: Watched<Bool> { annotation.loading }
  public var error: Watched<(any Error)?> { annotation.error }
  public var resourceContext: Watched<GatheredContext?> { resource.context }
  public var resourceLoading: Watched<Bool> { resource.loading }
  public var resourceError: Watched<(any Error)?> { resource.error }

  private let gather: GatherNamespace
  private let resourceId: ResourceId
  private let life = Lifetime()

  public init(client: SemiontClient, resourceId: ResourceId) {
    gather = client.gather
    self.resourceId = resourceId
  }

  public func gatherAnnotation(_ id: AnnotationId, options: GatherAnnotationOptions? = nil) {
    life.whileOpen {
      annotation.begin()
      annotationId.set(id)
    }
    land(annotation) { [gather, resourceId] in
      try await gather.annotation(resourceId: resourceId, annotationId: id, options: options)
        .completed().response
    }
  }

  public func gatherResource(_ id: ResourceId, options: GatherResourceOptions? = nil) {
    life.whileOpen { resource.begin() }
    land(resource) { [gather] in try await gather.resource(id, options: options) }
  }

  private func land(
    _ target: Gathering, _ request: @escaping @Sendable () async throws -> GatheredContext
  ) {
    life.start { [weak self] in
      do {
        let context = try await request()
        self?.life.whileOpen {
          target.context.set(context)
          target.loading.set(false)
        }
      } catch {
        self?.life.whileOpen {
          target.error.set(error)
          target.loading.set(false)
        }
      }
    }
  }

  public func dispose() {
    life.end()
    annotation.finish()
    annotationId.finish()
    resource.finish()
  }

  deinit { dispose() }
}
