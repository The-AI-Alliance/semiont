using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Types;

namespace Semiont.Testing;

public sealed record TestSessionOptions(FaultyTransport? Transport = null, KbTarget? Kb = null,
    ISignInKept? Kept = null, TimeProvider? TimeProvider = null, Timing? Timing = null);

/// <summary>An offline session over a real SDK client. Disposal closes the session and client.</summary>
public sealed class TestSession : IDisposable
{
    private readonly HttpClient http;
    private readonly KeptSession credentials;
    public SemiontSession Session { get; }
    public SemiontClient Client => Session.Client;
    public FaultyTransport Transport { get; }
    public ISignInKept Kept { get; }

    internal TestSession(SemiontSession session, FaultyTransport transport, ISignInKept kept, KeptSession credentials, HttpClient http)
    {
        Session = session;
        Transport = transport;
        Kept = kept;
        this.credentials = credentials;
        this.http = http;
    }

    /// <summary>Updates the live credential for a test without changing kept storage.</summary>
    public void SetToken(string? token)
    {
        credentials.SetOfflineToken(token);
        Session.UpdateIdentity();
    }

    public void Dispose()
    {
        try { Session.Dispose(); }
        finally
        {
            try { Client.Dispose(); }
            finally { http.Dispose(); }
        }
    }
}

public static class TestSessions
{
    /// <summary>Starts from the kept token without validating or renewing it. A supplied transport remains caller-owned.</summary>
    public static async Task<TestSession> CreateTestSessionAsync(TestSessionOptions? options = null, CancellationToken cancellation = default)
    {
        options ??= new();
        var kb = options.Kb ?? new KbTarget
        {
            Id = "test-kb",
            Label = "Test KB",
            Endpoint = new KbEndpoint.HttpEndpointCase(new HttpEndpoint { Host = "localhost", Port = 4000, Protocol = HttpEndpointProtocol.Http }),
        };
        if (kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "The test session requires an HTTP endpoint.");
        var origin = Gateway.Origin(endpoint);
        var transport = options.Transport ?? new FaultyTransport(timeProvider: options.TimeProvider);
        var http = new HttpClient(transport, disposeHandler: options.Transport is null);
        var kept = options.Kept ?? new MemorySignIn();
        var credentials = new KeptSession(kept,
            (_, _) => throw new InvalidOperationException("An offline session does not renew."),
            (_, _) => throw new InvalidOperationException("An offline session does not validate."),
            options.TimeProvider ?? TimeProvider.System, Random.Shared, offline: true);
        SemiontClient? client = null;
        try
        {
            await credentials.ReadyAsync(cancellation).ConfigureAwait(false);
            var bus = new HttpTransport(origin, credentials.State.Token,
                ProtocolFacts.Channels("everyone").Concat(ProtocolFacts.OperationReplies()),
                timing: options.Timing, refresher: credentials.RefreshAsync, httpClient: http, timeProvider: options.TimeProvider);
            client = new SemiontClient(bus);
            return new TestSession(new SemiontSession(kb, client, credentials), transport, kept, credentials, http);
        }
        catch
        {
            credentials.Dispose();
            client?.Dispose();
            http.Dispose();
            throw;
        }
    }
}
