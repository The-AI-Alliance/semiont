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
        for try await carried in frames {
          self?.hear(carried)
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

  /// Act on what was heard. A frame refused, or one whose payload is not its channel's, is nobody's
  /// to act on.
  private func hear(_ carried: Carried) {
    switch carried.channel {
    case Channels.beckonHover.name:
      let channel = Channels.beckonHover
      guard
        case .delivered(let hovered) = heard(
          BeckonHoverEvent.self, on: channel.name, stamps: channel.stamps, carried)
      else { return }
      let hover = hovered.payload
      life.whileOpen {
        hoveredAnnotationId.set(hover.annotationId)
        if let id = hover.annotationId {
          try? bus.emit(Channels.beckonSparkle, BeckonSparkleEvent(annotationId: id))
        }
      }
    case Channels.browseClick.name:
      let channel = Channels.browseClick
      if case .delivered(let click) = heard(
        BrowseClickEvent.self, on: channel.name, stamps: channel.stamps, carried)
      {
        focus(click.payload.annotationId)
      }
    default: break
    }
  }

  public func dispose() {
    life.end()
    hoveredAnnotationId.finish()
  }

  deinit { dispose() }
}
