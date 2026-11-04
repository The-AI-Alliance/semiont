using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class BeckonNamespace
{
    private readonly Bus wire;
    private readonly EventBus bus;

    internal BeckonNamespace(Bus wire, EventBus bus)
    {
        this.wire = wire;
        this.bus = bus;
    }

    public Task<int?> AttentionAsync(ResourceId resourceId, AnnotationId? annotationId = null,
        CancellationToken cancellation = default) =>
        CountAsync(BusChannels.BeckonFocus, new BeckonFocusEvent { ResourceId = resourceId, AnnotationId = annotationId }, cancellation);

    public Task<int?> ClickAsync(AnnotationId annotationId, CancellationToken cancellation = default) =>
        CountAsync(BusChannels.BrowseClick, new BrowseClickEvent { AnnotationId = annotationId }, cancellation);

    public Task<int?> OpenResourceAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        CountAsync(BusChannels.BrowseResourceOpen, new BrowseResourceOpenEvent { ResourceId = resourceId }, cancellation);

    public Task<int?> SparkleAllAsync(AnnotationId annotationId, CancellationToken cancellation = default) =>
        CountAsync(BusChannels.BeckonSparkle, new BeckonSparkleEvent { AnnotationId = annotationId }, cancellation);

    public void Hover(AnnotationId? annotationId) =>
        bus.Emit(BusChannels.BeckonHover, new BeckonHoverEvent { AnnotationId = annotationId });

    public void Sparkle(AnnotationId annotationId) =>
        bus.Emit(BusChannels.BeckonSparkle, new BeckonSparkleEvent { AnnotationId = annotationId });

    private async Task<int?> CountAsync<T>(BusChannel<T> channel, T payload, CancellationToken cancellation) where T : class =>
        checked((int?)await wire.EmitAsync(channel, payload, cancellation: cancellation).ConfigureAwait(false));
}
