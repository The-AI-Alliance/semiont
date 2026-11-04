using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Storage;
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
    public KeptSession? Session { get; }

    public OpenedSession(SemiontClient client, Func<ValueTask>? close = null, KeptSession? session = null)
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
            var watching = Task.WhenAll(FollowTokenAsync(), FollowErrorsAsync(), FollowPermissionAsync());
            return new OpenedSession(client, async () =>
            {
                try { kept.Dispose(); }
                finally { client.Dispose(); }
                await watching.ConfigureAwait(false);
            }, kept);

            async Task FollowTokenAsync()
            {
                await foreach (var state in kept.States().ConfigureAwait(false)) http.SetToken(state.Token);
            }

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
public sealed record KbIdentityConflict(string ExpectedDid, string ObservedDid);
public sealed record PermissionDenied(string? Detail);
public sealed record SessionNotices(string? SessionEnded, PermissionDenied? PermissionDenied, KbIdentityConflict? KbIdentityConflict);

/// <summary>Notices for the host. Raising the same notice twice is observable twice.</summary>
public sealed class SessionSignals : IDisposable
{
    private readonly object gate = new();
    private readonly Broadcast<SessionNotices> states = new(replayLatest: true);
    private SessionNotices current = new(null, null, null);
    private bool closed;

    public SessionSignals() => states.Publish(current);
    public SessionNotices State => Volatile.Read(ref current);
    public string? SessionEnded => State.SessionEnded;
    public PermissionDenied? PermissionDenied => State.PermissionDenied;
    public KbIdentityConflict? KbIdentityConflict => State.KbIdentityConflict;
    public IAsyncEnumerable<SessionNotices> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    public void NotifySessionEnded(string reason) => Change(state => state with { SessionEnded = reason });
    public void NotifyPermissionDenied(string? detail) => Change(state => state with { PermissionDenied = new PermissionDenied(detail) });
    public void NotifyKbIdentityConflict(KbIdentityConflict conflict) => Change(state => state with { KbIdentityConflict = conflict });
    public void AcknowledgeSessionEnded() => Change(state => state with { SessionEnded = null });
    public void AcknowledgePermissionDenied() => Change(state => state with { PermissionDenied = null });
    public void AcknowledgeKbIdentityConflict() => Change(state => state with { KbIdentityConflict = null });

    private void Change(Func<SessionNotices, SessionNotices> change)
    {
        lock (gate)
        {
            if (closed) return;
            Volatile.Write(ref current, change(current));
            states.Publish(current);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            closed = true;
            states.Close();
        }
    }
}
