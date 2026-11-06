using Semiont.Errors;
using Semiont.Protocol;

namespace Semiont;

public static class BusRegistry
{
    public static readonly IReadOnlyList<string> PersistedEventTypes = Array.AsReadOnly(ProtocolFacts.EventChannels().ToArray());

    public static IReadOnlyList<string> ReplyChannelsFor(params IEnumerable<string> requests)
    {
        var replies = new List<string>();
        foreach (var request in requests)
        {
            foreach (var (_, result, failure) in ProtocolFacts.Operations().Where(operation => operation.Request == request))
            {
                if (!replies.Contains(result)) replies.Add(result);
                if (!replies.Contains(failure)) replies.Add(failure);
            }
        }
        return replies.AsReadOnly();
    }

    public static BusRequestError Unsubscribed(string channel) => new(ProtocolFacts.BusError("unsubscribed"),
        "Transport is not subscribed to " + channel + ": a frame on it can never arrive on this connection. Add the channel to this client's channels.");
}
