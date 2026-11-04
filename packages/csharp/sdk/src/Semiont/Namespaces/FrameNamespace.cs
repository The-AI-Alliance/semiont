using System.Text.Json;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class FrameNamespace
{
    private static readonly string AddEntityType = ProtocolFacts.RequestChannel(nameof(FrameAddEntityTypeCommand));
    private static readonly string AddTagSchema = ProtocolFacts.RequestChannel(nameof(FrameAddTagSchemaCommand));
    private readonly HttpTransport transport;

    internal FrameNamespace(HttpTransport transport) => this.transport = transport;

    internal static IEnumerable<string> ReplyChannels()
    {
        var entity = ProtocolFacts.Operation(AddEntityType);
        var schema = ProtocolFacts.Operation(AddTagSchema);
        return [entity.Result, entity.Failure, schema.Result, schema.Failure];
    }

    public async Task AddEntityTypeAsync(string type, CancellationToken cancellation = default)
    {
        var payload = JsonSerializer.SerializeToElement(new FrameAddEntityTypeCommand { Tag = type });
        await transport.RequestAsync(AddEntityType, payload, cancellation: cancellation).ConfigureAwait(false);
    }

    public async Task AddEntityTypesAsync(IEnumerable<string> types, CancellationToken cancellation = default)
    {
        foreach (var type in types)
            await AddEntityTypeAsync(type, cancellation).ConfigureAwait(false);
    }

    public async Task AddTagSchemaAsync(TagSchema schema, CancellationToken cancellation = default)
    {
        var payload = JsonSerializer.SerializeToElement(new FrameAddTagSchemaCommand { Schema = schema });
        await transport.RequestAsync(AddTagSchema, payload, cancellation: cancellation).ConfigureAwait(false);
    }
}
