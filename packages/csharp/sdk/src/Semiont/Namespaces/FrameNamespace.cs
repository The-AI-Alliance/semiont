using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class FrameNamespace
{
    private readonly Bus wire;

    internal FrameNamespace(Bus wire) => this.wire = wire;

    public async Task AddEntityTypeAsync(string type, CancellationToken cancellation = default)
    {
        await wire.RequestAsync(BusOperations.FrameAddEntityType, new FrameAddEntityTypeCommand { Tag = type }, cancellation: cancellation).ConfigureAwait(false);
    }

    public async Task AddEntityTypesAsync(IEnumerable<string> types, CancellationToken cancellation = default)
    {
        foreach (var type in types)
            await AddEntityTypeAsync(type, cancellation).ConfigureAwait(false);
    }

    public async Task AddTagSchemaAsync(TagSchema schema, CancellationToken cancellation = default)
    {
        await wire.RequestAsync(BusOperations.FrameAddTagSchema, new FrameAddTagSchemaCommand { Schema = schema }, cancellation: cancellation).ConfigureAwait(false);
    }
}
