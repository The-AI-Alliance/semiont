using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Storage;
using Semiont.State;
using Semiont.Types;

namespace Semiont.Registry;

public sealed record SemiontBrowserConfig(ISessionStorage Storage, SessionFactory SessionFactory, TimeProvider? TimeProvider = null,
    Random? Random = null);
public sealed record SessionFactoryOptions(KnowledgeBase Kb, ISessionStorage Storage, SessionSignals Signals);

public interface SessionFactory
{
    public Task<OpenedSession> OpenAsync(SessionFactoryOptions options, CancellationToken cancellation = default);
    public Task RevokeAsync(StoredSession stored, CancellationToken cancellation = default);
}

public sealed class OpenedSession : IAsyncDisposable
{
    private readonly Func<ValueTask> close;
    private readonly object gate = new();
    private Task? closing;
    public SemiontClient Client { get; }
    public SemiontSession? Session { get; }

    public OpenedSession(SemiontClient client, Func<ValueTask>? close = null, SemiontSession? session = null)
    {
        Client = client;
        Session = session;
        this.close = close ?? (() => { client.Dispose(); return ValueTask.CompletedTask; });
    }

    public ValueTask DisposeAsync()
    {
        lock (gate) return new ValueTask(closing ??= Spawning.Run(CloseAsync));
    }

    private async Task CloseAsync() => await close().ConfigureAwait(Spawning.Captures);
}

/// <summary>
/// Opens an active knowledge base with the same kept session used for other HTTP clients. Its client keeps what it holds
/// for the person the knowledge base's sign-in names, from when the sign-in names them. Its session tells the signals it
/// is given why it ended, as it signs out.
/// </summary>
public sealed class HttpSessionFactory(HttpClient? httpClient = null, TimeProvider? timeProvider = null, Random? random = null) : SessionFactory
{
    public async Task<OpenedSession> OpenAsync(SessionFactoryOptions options, CancellationToken cancellation = default)
    {
        if (options.Kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "This factory requires an HTTP endpoint.");
        var errors = new Broadcast<SemiontError>(keptForFirst: SemiontError.KeptForFirstReader);
        // The client writes only while the sign-in stored beside it names its person, read through what holds it there.
        var persistence = new CachePersistence(options.Storage, options.Kb.Id, RegistryStorage.KeptIn(options.Storage, options.Kb.Id), errors.Publish);
        var signIn = RegistryStorage.KeptFor(persistence);
        if (RegistryStorage.StoredSession(options.Storage, options.Kb.Id) is { PersonKey: { } named }) persistence.Attach(named);
        var kept = new KeptSession(endpoint, signIn, httpClient, timeProvider, random, errors, validates: true, answered: persistence.RecordAsync,
            onAuthFailed: options.Signals.NotifySessionEnded);
        HttpTransport? transport = null;
        try
        {
            await kept.ReadyAsync(cancellation).ConfigureAwait(Spawning.Captures);
            var http = new HttpTransport(Gateway.Origin(endpoint), kept.State.Token,
                BusRegistry.BridgedChannels, refresher: kept.RefreshAsync,
                httpClient: httpClient, timeProvider: timeProvider, random: random);
            transport = http;
            var client = new SemiontClient(http, persistence);
            var session = new SemiontSession(new KbTarget { Id = options.Kb.Id, Endpoint = options.Kb.Endpoint, Label = options.Kb.Label },
                client, kept);
            return new OpenedSession(client, async () =>
            {
                // The client first, its closing save awaited: what that save says reaches the session's errors before they end.
                try
                {
                    client.Dispose();
                    await client.Flushed.ConfigureAwait(Spawning.Captures);
                }
                finally
                {
                    session.Dispose();
                    // A renewal under way at the issuer runs to its end, and what it brings is kept, before the close returns.
                    await kept.DisposeAsync().ConfigureAwait(Spawning.Captures);
                }
            }, session);
        }
        catch
        {
            kept.Dispose();
            transport?.Dispose();
            throw;
        }
    }

    public async Task RevokeAsync(StoredSession stored, CancellationToken cancellation = default)
    {
        using var issuer = new Issuer(httpClient, timeProvider, random);
        await issuer.SignOutAsync(new MemorySignIn(stored), cancellation).ConfigureAwait(Spawning.Captures);
    }
}

public enum KbSessionStatus { Authenticated, Expired, SignedOut }
