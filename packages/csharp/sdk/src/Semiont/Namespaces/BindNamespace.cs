using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class BindNamespace
{
    private readonly Bus wire;
    private readonly EventBus bus;

    internal BindNamespace(Bus wire, EventBus bus)
    {
        this.wire = wire;
        this.bus = bus;
    }

    public async Task BodyAsync(ResourceId resourceId, AnnotationId annotationId,
        IReadOnlyList<BindBodyOperation> operations, CancellationToken cancellation = default)
    {
        await wire.RequestAsync(BusOperations.BindUpdateBody, new BindUpdateBodyCommand
        {
            ResourceId = resourceId,
            AnnotationId = annotationId,
            Operations = operations,
        }, cancellation: cancellation).ConfigureAwait(false);
    }

    public void Initiate(BindInitiateCommand input) => bus.Emit(BusChannels.BindInitiate, input);

    public void ReportBodyError(ResourceErrorEvent input) => bus.Emit(BusChannels.BindBodyError, input);
}
