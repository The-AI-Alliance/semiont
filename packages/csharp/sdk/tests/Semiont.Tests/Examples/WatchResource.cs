using Semiont;
using Semiont.Identifiers;
using Semiont.Types;

public static class WatchResource
{
    public static async Task RunAsync(SemiontClient client, ResourceId resourceId,
        TextWriter output, CancellationToken cancellation = default)
    {
        await foreach (var state in client.Browse.Resource(resourceId).WithCancellation(cancellation))
        {
            var message = state switch
            {
                CacheState<ResourceDescriptor>.Pending => "Loading…",
                CacheState<ResourceDescriptor>.Ready(var resource) => resource.Name,
                CacheState<ResourceDescriptor>.Failed(var error) => error.Message,
            };
            await output.WriteLineAsync(message);
        }
    }
}
