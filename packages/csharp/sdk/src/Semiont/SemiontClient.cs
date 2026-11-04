using Semiont.Http;
using Semiont.Namespaces;
using Semiont.Protocol;

namespace Semiont;

public sealed class SemiontClient : IDisposable
{
    public SemiontClient(string baseUrl, string? token = null, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
        : this(new HttpTransport(baseUrl, token, ProtocolFacts.Channels("everyone").Concat(FrameNamespace.ReplyChannels()),
            httpClient: httpClient, timeProvider: timeProvider, random: random))
    {
    }

    /// <summary>Owns the transport. Supply subscriptions for the operations the client will use.</summary>
    public SemiontClient(HttpTransport transport)
    {
        ArgumentNullException.ThrowIfNull(transport);
        Transport = transport;
        Frame = new FrameNamespace(transport);
        Auth = new AuthNamespace(transport);
        System = new SystemNamespace(transport);
    }

    public HttpTransport Transport { get; }
    public string BaseUrl => Transport.BaseUrl;
    public ConnectionState State => Transport.State;
    public FrameNamespace Frame { get; }
    public AuthNamespace Auth { get; }
    public SystemNamespace System { get; }

    public void Dispose() => Transport.Dispose();
}
