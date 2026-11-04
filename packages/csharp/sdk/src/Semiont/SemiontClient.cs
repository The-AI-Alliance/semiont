using Semiont.Http;
using Semiont.Namespaces;
using Semiont.Protocol;

namespace Semiont;

public sealed class SemiontClient : IDisposable
{
    public SemiontClient(string baseUrl, string? token = null, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
        : this(new HttpTransport(baseUrl, token, ProtocolFacts.Channels("everyone").Concat(ProtocolFacts.OperationReplies()),
            httpClient: httpClient, timeProvider: timeProvider, random: random))
    {
    }

    /// <summary>Owns the transport. Supply subscriptions for the operations the client will use.</summary>
    public SemiontClient(HttpTransport transport)
    {
        ArgumentNullException.ThrowIfNull(transport);
        Transport = transport;
        Wire = new Bus(transport);
        Bus = new EventBus();
        Bind = new BindNamespace(Wire, Bus);
        Beckon = new BeckonNamespace(Wire, Bus);
        Gather = new GatherNamespace(Wire);
        Match = new MatchNamespace(Wire, Bus);
        Job = new JobNamespace(Wire, Bus, transport.Clock, transport.Closed);
        var follower = new JobFollower(Wire, Bus, Job, transport.Clock, transport.Closed);
        Mark = new MarkNamespace(Wire, Bus, follower);
        Yield = new YieldNamespace(follower);
        Frame = new FrameNamespace(Wire);
        Auth = new AuthNamespace(transport);
        System = new SystemNamespace(transport);
        _ = BridgeAsync();
    }

    public Bus Wire { get; }
    public EventBus Bus { get; }
    public BindNamespace Bind { get; }
    public BeckonNamespace Beckon { get; }
    public GatherNamespace Gather { get; }
    public MatchNamespace Match { get; }
    public MarkNamespace Mark { get; }
    public YieldNamespace Yield { get; }
    public JobNamespace Job { get; }
    public HttpTransport Transport { get; }
    public string BaseUrl => Transport.BaseUrl;
    public ConnectionState State => Transport.State;
    public FrameNamespace Frame { get; }
    public AuthNamespace Auth { get; }
    public SystemNamespace System { get; }

    private async Task BridgeAsync()
    {
        try
        {
            await foreach (var frame in Transport.BridgeFrames().ConfigureAwait(false)) Bus.Receive(frame);
        }
        finally { Bus.Dispose(); }
    }

    public void Dispose()
    {
        Bus.Dispose();
        Transport.Dispose();
    }
}
