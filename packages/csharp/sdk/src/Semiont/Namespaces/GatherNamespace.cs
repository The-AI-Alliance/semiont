using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class GatherNamespace
{
    private readonly Bus wire;
    private readonly LiveQueries live;

    internal GatherNamespace(Bus wire, LiveQueries live)
    {
        this.wire = wire;
        this.live = live;
    }

    public Cached<IReadOnlyList<GetReferencedByResponseReferencedByItem>> ReferencedBy(ResourceId resourceId) =>
        live.ReferencedBy.Observe(resourceId);

    public Running<GatherAnnotationComplete> Annotation(ResourceId resourceId, AnnotationId annotationId,
        GatherAnnotationOptions? options = null)
    {
        options ??= new GatherAnnotationOptions();
        var request = new GatherAnnotationRequest
        {
            ResourceId = resourceId,
            AnnotationId = annotationId,
            Options = options with { ContextWindow = options.ContextWindow ?? 2000 },
        };
        return new((_, cancellation) => wire.RequestAsync(BusOperations.GatherRequested, request, cancellation: cancellation));
    }

    public async Task<GatheredContext> ResourceAsync(ResourceId resourceId, long depth = 2, long maxResources = 10,
        bool includeContent = true, bool includeSummary = false, IReadOnlyList<string>? excludeEntityTypes = null,
        CancellationToken cancellation = default)
    {
        var request = new GatherResourceRequest
        {
            ResourceId = resourceId,
            Options = new GatherResourceRequestOptions
            {
                Depth = depth,
                MaxResources = maxResources,
                IncludeContent = includeContent,
                IncludeSummary = includeSummary,
                ExcludeEntityTypes = excludeEntityTypes is { Count: > 0 } ? excludeEntityTypes : null,
            },
        };
        return (await wire.RequestAsync(BusOperations.GatherResourceRequested, request, cancellation: cancellation)
            .ConfigureAwait(false)).Response;
    }
}
