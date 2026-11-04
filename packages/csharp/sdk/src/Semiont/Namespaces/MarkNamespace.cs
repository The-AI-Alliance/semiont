using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class MarkNamespace
{
    private readonly Bus wire;
    private readonly EventBus bus;

    internal MarkNamespace(Bus wire, EventBus bus)
    {
        this.wire = wire;
        this.bus = bus;
    }

    public async Task<MarkCreateOkResponse> AnnotationAsync(CreateAnnotationRequest input, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.MarkCreateRequest, new MarkCreateRequest
        {
            Request = input,
            ResourceId = input.Target.Source,
        }, cancellation: cancellation).ConfigureAwait(false)).Response;

    public Task DeleteAsync(ResourceId resourceId, AnnotationId annotationId, CancellationToken cancellation = default) =>
        wire.RequestAsync(BusOperations.MarkDelete, new MarkDeleteCommand
        {
            ResourceId = resourceId,
            AnnotationId = annotationId,
        }, cancellation: cancellation);

    public Task ArchiveAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        wire.RequestAsync(BusOperations.MarkArchive, new MarkArchiveCommand { ResourceId = resourceId }, cancellation: cancellation);

    public Task UnarchiveAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        wire.RequestAsync(BusOperations.MarkUnarchive, new MarkUnarchiveCommand { ResourceId = resourceId }, cancellation: cancellation);

    public Task UpdateEntityTypesAsync(ResourceId resourceId, IReadOnlyList<string> current, IReadOnlyList<string> updated,
        CancellationToken cancellation = default) =>
        wire.RequestAsync(BusOperations.MarkUpdateEntityTypes, new MarkUpdateEntityTypesCommand
        {
            ResourceId = resourceId,
            CurrentEntityTypes = current,
            UpdatedEntityTypes = updated,
        }, cancellation: cancellation);

    public void Request(ResourceId source, AnnotationSelector selector, Motivation motivation) =>
        bus.Emit(BusChannels.MarkRequested, new MarkRequestedEvent { Source = source, Selector = selector, Motivation = motivation });

    public void Submit(MarkSubmitEvent input) => bus.Emit(BusChannels.MarkSubmit, input);

    public void ReportDeleteError(ResourceErrorEvent input) => bus.Emit(BusChannels.MarkDeleteError, input);
}
