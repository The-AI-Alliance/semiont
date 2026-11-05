using System.Collections.Concurrent;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Session;
using Semiont.Types;

namespace Semiont.Testing;

public closed record Renewal
{
    public sealed record Token(string? Value) : Renewal;
    public sealed record Failure(SignInError Error) : Renewal;
}

/// <summary>A factory that opens real sessions with scripted gateway answers, identity, and renewal.</summary>
public sealed class ScriptedSessions(Func<string, string, JsonElement, JsonElement?>? answer = null,
    TimeProvider? timeProvider = null) : SessionFactory
{
    private readonly ConcurrentQueue<Renewal> renewals = new();
    private readonly ConcurrentQueue<(string KbId, FaultyTransport Transport)> built = new();
    private readonly ConcurrentQueue<StoredSession> revoked = new();
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private volatile Func<string, string, JsonElement, JsonElement?>? refusal;
    private volatile string? constructFailure;
    private volatile UserResponse? user;
    private long identityDelayTicks;
    private int renewed;

    public IReadOnlyList<StoredSession> Revoked => revoked.ToArray();
    public int Renewed => Volatile.Read(ref renewed);
    public IReadOnlyList<FaultyTransport> Transports(string kbId) =>
        built.Where(entry => entry.KbId == kbId).Select(entry => entry.Transport).ToArray();

    public void QueueRenewals(params Renewal[] scripted)
    {
        foreach (var renewal in scripted) renewals.Enqueue(renewal);
    }

    public void SaysWho(UserResponse identity) => user = identity;
    public void AnswersAfter(TimeSpan delay) => Interlocked.Exchange(ref identityDelayTicks, delay.Ticks);
    public void RefuseToBuild(string? reason) => constructFailure = reason;
    public void RefuseWhen(Func<string, string, JsonElement, JsonElement?>? refuse) => refusal = refuse;

    public async Task<OpenedSession> OpenAsync(SessionFactoryOptions options, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var kb = options.Kb;
        if (constructFailure is { } reason)
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), reason);
        if (kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "The scripted session requires an HTTP endpoint.");
        var origin = Gateway.Origin(endpoint);
        var transport = new FaultyTransport(respond: Answer, timeProvider: clock)
        {
            Refusal = (operation, payload) => refusal?.Invoke(kb.Id, operation, payload),
        };
        built.Enqueue((kb.Id, transport));
        var http = new HttpClient(transport);
        var stored = RegistryStorage.KeptIn(options.Storage, kb.Id);
        var identity = user;
        var delay = TimeSpan.FromTicks(Interlocked.Read(ref identityDelayTicks));
        var kept = new KeptSession(stored, RenewAsync, IdentifyAsync, clock, Random.Shared);
        SemiontClient? client = null;
        try
        {
            await kept.ReadyAsync(cancellation).ConfigureAwait(false);
            var bus = new HttpTransport(origin, kept.State.Token,
                ProtocolFacts.Channels("everyone").Concat(ProtocolFacts.OperationReplies()),
                refresher: kept.RefreshAsync, httpClient: http, timeProvider: clock);
            var openedClient = client = new SemiontClient(bus);
            var session = new SemiontSession(new KbTarget { Id = kb.Id, Label = kb.Label, Endpoint = kb.Endpoint }, openedClient, kept);
            var watching = Task.WhenAll(ErrorsAsync(), PermissionsAsync());
            return new OpenedSession(openedClient, async () =>
            {
                try { session.Dispose(); }
                finally
                {
                    try { openedClient.Dispose(); }
                    finally { http.Dispose(); }
                }
                await watching.ConfigureAwait(false);
            }, session);

            async Task ErrorsAsync()
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

            async Task PermissionsAsync()
            {
                await foreach (var error in bus.Errors().ConfigureAwait(false))
                    if (error.Status == 403) options.Signals.NotifyPermissionDenied(error.Message);
            }
        }
        catch
        {
            kept.Dispose();
            client?.Dispose();
            http.Dispose();
            throw;
        }

        JsonElement? Answer(string operation, JsonElement payload) => answer is { } scripted
            ? scripted(kb.Id, operation, payload)
            : throw new TransportError(ProtocolFacts.Error(0), $"No response scripted for '{operation}' of knowledge base '{kb.Id}'.");

        async Task<UserResponse> IdentifyAsync(string _, CancellationToken stop)
        {
            if (delay > TimeSpan.Zero) await Task.Delay(delay, clock, stop).ConfigureAwait(false);
            return identity ?? throw new TransportError(ProtocolFacts.Error(0), $"No identity scripted for knowledge base '{kb.Id}'.");
        }

        async Task<string?> RenewAsync(string? _, CancellationToken stop)
        {
            Interlocked.Increment(ref renewed);
            if (!renewals.TryDequeue(out var renewal))
                throw new SignInError(ProtocolFacts.SignInError("exchange"), $"No renewal scripted for knowledge base '{kb.Id}'.", 503);
            if (renewal is Renewal.Failure(var error)) throw error;
            if (renewal is Renewal.Token(var token) && token is not null && await stored.HeldAsync(stop).ConfigureAwait(false) is { } read)
                return await stored.RenewedAsync(read, token, read.Refresh, stop).ConfigureAwait(false);
            return null;
        }
    }

    public Task RevokeAsync(StoredSession stored, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        revoked.Enqueue(stored);
        return Task.CompletedTask;
    }
}
