using System.Text.Json;
using Semiont.Errors;
using Semiont.Types;

namespace Semiont.State;

public sealed class MatchStateUnit : IStateUnit
{
    private readonly SemiontClient client;
    private readonly UnitWork work;
    private readonly EventBus.Subscription events;

    public MatchStateUnit(SemiontClient client)
    {
        this.client = client;
        work = new UnitWork(client.Transport.Closed);
        events = client.Bus.Listen([BusChannels.MatchSearchRequested.Name]);
        work.Run(ReadAsync);
    }

    private async Task ReadAsync(CancellationToken cancellation)
    {
        await foreach (var received in events.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
        {
            lock (work.Gate)
            {
                if (!work.Active) return;
                MatchSearchRequest request;
                try { request = Bus.Decode<MatchSearchRequest>(received.Frame.Payload); }
                catch (JsonException) { continue; }
                work.Run(token => SearchAsync(request, received.Frame.CorrelationId, token));
            }
        }
    }

    private async Task SearchAsync(MatchSearchRequest request, string? correlationId, CancellationToken cancellation)
    {
        try
        {
            var found = await client.Match.Search(request.ResourceId, request.ReferenceId, request.Context,
                request.Limit ?? 10, request.UseSemanticScoring ?? true).CompleteAsync(cancellation).ConfigureAwait(false);
            lock (work.Gate)
                if (work.Active) client.Bus.Emit(BusChannels.MatchSearchResults, found, correlationId: correlationId);
        }
        catch (SemiontError error)
        {
            lock (work.Gate)
                if (work.Active) client.Bus.Emit(BusChannels.MatchSearchFailed,
                    new MatchSearchFailed { ReferenceId = request.ReferenceId, Error = error.Message }, correlationId: correlationId);
        }
    }

    public void Dispose()
    {
        lock (work.Gate) { work.Dispose(); events.Dispose(); }
    }
}
