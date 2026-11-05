using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.State;

public sealed class GatherStateUnit : IStateUnit
{
    private readonly SemiontClient client;
    private readonly ResourceId annotationResource;
    private readonly UnitWork work;
    private readonly GatherSlot annotation = new();
    private readonly GatherSlot resource = new();

    public StateValue<GatheredContext?> Context => annotation.Context;
    public StateValue<bool> Loading => annotation.Loading;
    public StateValue<SemiontError?> Error => annotation.Error;
    public StateValue<AnnotationId?> AnnotationId { get; } = new(null);
    public StateValue<GatheredContext?> ResourceContext => resource.Context;
    public StateValue<bool> ResourceLoading => resource.Loading;
    public StateValue<SemiontError?> ResourceError => resource.Error;

    public GatherStateUnit(SemiontClient client, ResourceId resourceId)
    {
        this.client = client;
        annotationResource = resourceId;
        work = new UnitWork(client.Transport.Closed);
    }

    public void GatherAnnotation(AnnotationId annotationId, GatherAnnotationOptions? options = null)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            AnnotationId.Set(annotationId);
            Start(annotation, async token => (await client.Gather.Annotation(annotationResource, annotationId, options)
                .CompleteAsync(token).ConfigureAwait(false)).Response);
        }
    }

    public void GatherResource(ResourceId resourceId, long depth = 2, long maxResources = 10, bool includeContent = true,
        bool includeSummary = false, IReadOnlyList<string>? excludeEntityTypes = null)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            Start(resource, token => client.Gather.ResourceAsync(resourceId, depth, maxResources, includeContent,
                includeSummary, excludeEntityTypes, token));
        }
    }

    private void Start(GatherSlot slot, Func<CancellationToken, Task<GatheredContext>> gather)
    {
        slot.Loading.Set(true);
        slot.Context.Set(null);
        slot.Error.Set(null);
        work.Run(token => LandAsync(slot, gather, token));
    }

    private async Task LandAsync(GatherSlot slot, Func<CancellationToken, Task<GatheredContext>> gather, CancellationToken token)
    {
        GatheredContext? context = null;
        SemiontError? failure = null;
        try { context = await gather(token).ConfigureAwait(false); }
        catch (SemiontError error) { failure = error; }
        lock (work.Gate)
        {
            if (!work.Active) return;
            slot.Context.Set(context);
            slot.Error.Set(failure);
            slot.Loading.Set(false);
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            annotation.Close();
            resource.Close();
            AnnotationId.Close();
        }
    }

    private sealed class GatherSlot
    {
        internal StateValue<GatheredContext?> Context { get; } = new(null);
        internal StateValue<bool> Loading { get; } = new(false);
        internal StateValue<SemiontError?> Error { get; } = new(null);

        internal void Close()
        {
            Context.Close();
            Loading.Close();
            Error.Close();
        }
    }
}
