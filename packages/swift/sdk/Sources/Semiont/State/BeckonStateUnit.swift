/// Holds a viewer's attention and focuses its resource when an annotation is clicked.
public final class BeckonStateUnit: StateUnit {
  public let hoveredAnnotationId = Watched<AnnotationId?>(nil)
  private let bus: EventBus
  private let resourceId: ResourceId
  private let life = Lifetime()

  public init(client: SemiontClient, resourceId: ResourceId) {
    bus = client.bus
    self.resourceId = resourceId
    let frames = bus.listen([Channels.beckonHover.name, Channels.browseClick.name])
    life.onEnd { frames.dispose() }
    life.start { [weak self] in
      do {
        for try await frame in frames {
          self?.hear(frame)
        }
      } catch {}
    }
  }

  public func focus(_ annotationId: AnnotationId) {
    life.whileOpen {
      try? bus.emit(
        Channels.beckonFocus, BeckonFocusEvent(annotationId: annotationId, resourceId: resourceId))
    }
  }

  private func hear(_ frame: ReceivedFrame) {
    switch frame.channel {
    case Channels.beckonHover.name:
      guard let hover = try? frame.decode(Channels.beckonHover) else { return }
      life.whileOpen {
        hoveredAnnotationId.set(hover.annotationId)
        if let id = hover.annotationId {
          try? bus.emit(Channels.beckonSparkle, BeckonSparkleEvent(annotationId: id))
        }
      }
    case Channels.browseClick.name:
      if let click = try? frame.decode(Channels.browseClick) { focus(click.annotationId) }
    default: break
    }
  }

  public func dispose() {
    life.end()
    hoveredAnnotationId.finish()
  }

  deinit { dispose() }
}
