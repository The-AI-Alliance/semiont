using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class MatchNamespace
{
    private readonly Bus wire;
    private readonly LiveQueries live;
    private readonly EventBus bus;

    internal MatchNamespace(Bus wire, EventBus bus, LiveQueries live)
    {
        this.wire = wire;
        this.bus = bus;
        this.live = live;
    }

    public Cached<MatchResourcesResponse> Resources(string search, long limit = 100, long offset = 0,
        bool? archived = null, string? entityType = null) =>
        live.MatchedResources.Observe(new LiveQueries.Search(search, new LiveQueries.Filters(limit, offset, archived, entityType)));

    public Running<MatchSearchResult> Search(ResourceId resourceId, AnnotationId referenceId, GatheredContext context,
        long limit = 10, bool useSemanticScoring = true)
    {
        var request = new MatchSearchRequest
        {
            ResourceId = resourceId,
            ReferenceId = referenceId,
            Context = context,
            Limit = limit,
            UseSemanticScoring = useSemanticScoring,
        };
        return new((_, cancellation) => wire.RequestAsync(BusOperations.MatchSearchRequested, request, cancellation: cancellation));
    }

    public void RequestSearch(MatchSearchRequest input, string correlationId) =>
        bus.Emit(BusChannels.MatchSearchRequested, input, correlationId: correlationId);
}
