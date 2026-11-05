using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Semiont;
using Semiont.Identifiers;
using Semiont.Types;

public static class GatherAndDelegate
{
    public static async Task<YieldJobCompleteCommand> RunAsync(
        string endpoint, string token, ResourceId source, string storageUri,
        HttpClient? http = null, CancellationToken cancellation = default)
    {
        using var client = new SemiontClient(endpoint, token, http);
        var context = await client.Gather.ResourceAsync(source, cancellation: cancellation);
        var generation = client.Yield.Delegate(new GenerationJobParams
        {
            Context = context,
            Title = "Notes",
            StorageUri = storageUri,
        });
        return await generation.CompleteAsync(cancellation);
    }
}
