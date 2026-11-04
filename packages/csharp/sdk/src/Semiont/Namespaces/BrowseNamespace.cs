using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class BrowseNamespace
{
    private readonly Bus wire;
    private readonly EventBus bus;
    private readonly HttpContentTransport content;
    private readonly CancellationToken closed;
    private readonly LiveQueries live;

    internal BrowseNamespace(Bus wire, EventBus bus, HttpContentTransport content, CancellationToken closed, LiveQueries live)
    {
        this.wire = wire;
        this.bus = bus;
        this.content = content;
        this.closed = closed;
        this.live = live;
    }

    public Cached<ResourceDescriptor> Resource(ResourceId resourceId) => live.ResourcesById.Observe(resourceId);

    public Cached<ListResourcesResponse> Resources(long limit = 100, long offset = 0, bool? archived = null, string? entityType = null) =>
        live.Resources.Observe(new LiveQueries.Filters(limit, offset, archived, entityType));

    public Cached<IReadOnlyList<Annotation>> Annotations(ResourceId resourceId) => live.Annotations.Observe(resourceId);

    public Cached<Annotation> Annotation(ResourceId resourceId, AnnotationId annotationId) =>
        live.Annotation.Observe(new LiveQueries.AnnotationKey(resourceId, annotationId));

    public Cached<IReadOnlyList<string>> EntityTypes() => live.EntityTypes;
    public Cached<IReadOnlyList<TagSchema>> TagSchemas() => live.TagSchemas;
    public Cached<IReadOnlyList<EngineWithLimits>> Engines() => live.Engines;
    public Cached<IReadOnlyList<AttributedEvent>> Events(ResourceId resourceId) => live.Events.Observe(resourceId);

    public async Task<string> ResourceContentAsync(ResourceId resourceId, CancellationToken cancellation = default)
    {
        var representation = await content.GetBinaryAsync(resourceId, cancellation).ConfigureAwait(false);
        return RepresentationText.Decode(representation.Bytes, representation.ContentType);
    }

    public Task<GetResourceResponse> ResourceGraphAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        content.GetResourceGraphAsync(resourceId, cancellation);

    public Task<AnchoredTextAnswer> ResourceAnchoredTextAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        content.GetAnchoredTextAsync(resourceId, cancellation);

    public Task<BinaryContent> ResourceRepresentationAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        content.GetBinaryAsync(resourceId, cancellation);

    public Task<BinaryStream> ResourceRepresentationStreamAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        content.GetBinaryStreamAsync(resourceId, cancellation);

    public async Task<IReadOnlyList<AttributedEvent>> ResourceEventsAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.BrowseEventsRequested, new BrowseEventsRequest { ResourceId = resourceId },
            cancellation: cancellation).ConfigureAwait(false)).Response.Events;

    public async Task<GetAnnotationHistoryResponse> AnnotationHistoryAsync(ResourceId resourceId, AnnotationId annotationId,
        CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.BrowseAnnotationHistoryRequested,
            new BrowseAnnotationHistoryRequest { ResourceId = resourceId, AnnotationId = annotationId },
            cancellation: cancellation).ConfigureAwait(false)).Response;

    public async Task<BrowseDirectoryResultResponse> FilesAsync(string dirPath = ".", BrowseDirectoryRequestSort sort = BrowseDirectoryRequestSort.Name,
        CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.BrowseDirectoryRequested, new BrowseDirectoryRequest { Path = dirPath, Sort = sort },
            cancellation: cancellation).ConfigureAwait(false)).Response;

    public async Task<KbDescription> KbAsync(CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.BrowseKbRequested, new BrowseKbRequest(), cancellation: cancellation)
            .ConfigureAwait(false)).Response;

    public void Click(AnnotationId annotationId) =>
        bus.Emit(BusChannels.BrowseClick, new BrowseClickEvent { AnnotationId = annotationId });

    public void OpenResource(ResourceId resourceId) =>
        bus.Emit(BusChannels.BrowseResourceOpen, new BrowseResourceOpenEvent { ResourceId = resourceId });

    public void ResourceViewed(ResourceId resourceId) => _ = ReportViewedAsync(resourceId);

    private async Task ReportViewedAsync(ResourceId resourceId)
    {
        if (closed.IsCancellationRequested) return;
        try
        {
            await wire.EmitAsync(BusChannels.BrowseResourceViewed, new BrowseResourceViewedEvent { ResourceId = resourceId },
                cancellation: closed).ConfigureAwait(false);
        }
        catch (TransportError) { /* The transport reports the refusal on its error stream. */ }
        catch (OperationCanceledException) when (closed.IsCancellationRequested) { /* Closing abandons pending navigation reports. */ }
    }
}
