using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Storage;
using Semiont.State;
using Semiont.Types;

namespace Semiont.Registry;

public sealed record SemiontBrowserConfig(ISessionStorage Storage, SessionFactory SessionFactory, TimeProvider? TimeProvider = null);
public sealed record SessionFactoryOptions(KnowledgeBase Kb, ISessionStorage Storage, SessionSignals Signals, Action<SessionError> OnError);

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
        lock (gate) return new ValueTask(closing ??= Task.Run(CloseAsync));
    }

    private async Task CloseAsync() => await close().ConfigureAwait(false);
}

/// <summary>Opens an active knowledge base with the same kept session used for other HTTP clients.</summary>
public sealed class HttpSessionFactory(HttpClient? httpClient = null, TimeProvider? timeProvider = null) : SessionFactory
{
    public async Task<OpenedSession> OpenAsync(SessionFactoryOptions options, CancellationToken cancellation = default)
    {
        if (options.Kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "This factory requires an HTTP endpoint.");
        var kept = new KeptSession(endpoint, RegistryStorage.KeptIn(options.Storage, options.Kb.Id), httpClient, timeProvider);
        HttpTransport? transport = null;
        try
        {
            await kept.ReadyAsync(cancellation).ConfigureAwait(false);
            var http = new HttpTransport(Gateway.Origin(endpoint), kept.State.Token,
                ProtocolFacts.Channels("everyone").Concat(ProtocolFacts.OperationReplies()), refresher: kept.RefreshAsync,
                httpClient: httpClient, timeProvider: timeProvider);
            transport = http;
            var user = kept.State.User;
            var persistence = user is null ? null : new CachePersistence(options.Storage, RegistryStorage.CacheKey(options.Kb.Id, user.Did));
            var client = new SemiontClient(http, persistence);
            var session = new SemiontSession(new KbTarget { Id = options.Kb.Id, Endpoint = options.Kb.Endpoint, Label = options.Kb.Label },
                client, kept);
            var watching = Task.WhenAll(FollowErrorsAsync(), FollowPermissionAsync());
            return new OpenedSession(client, async () =>
            {
                try { session.Dispose(); }
                finally { client.Dispose(); }
                await watching.ConfigureAwait(false);
            }, session);

            async Task FollowErrorsAsync()
            {
                var told = false;
                await foreach (var error in kept.Errors().ConfigureAwait(false))
                {
                    if (!told && kept.EndReason is { } ended)
                    {
                        told = true;
                        options.Signals.NotifySessionEnded(ended);
                    }
                    options.OnError(error);
                }
            }

            async Task FollowPermissionAsync()
            {
                await foreach (var error in http.Errors().ConfigureAwait(false))
                    if (error.Status == 403) options.Signals.NotifyPermissionDenied(error.Message);
            }
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
        using var issuer = new Issuer(httpClient, timeProvider);
        await issuer.SignOutAsync(new MemorySignIn(stored), cancellation).ConfigureAwait(false);
    }
}

public enum KbSessionStatus { Authenticated, Expired, SignedOut }
