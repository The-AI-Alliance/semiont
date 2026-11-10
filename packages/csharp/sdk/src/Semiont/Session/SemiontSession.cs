using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.SignIn;
using Semiont.State;
using Semiont.Storage;
using Semiont.Types;

namespace Semiont.Session;

/// <summary>Owns a kept credential and binds it to a caller-owned client's transport.</summary>
public sealed class SemiontSession : IStateUnit
{
    private readonly KeptSession kept;
    private readonly UnitWork work;
    private readonly IDisposable relayed;

    public string Id { get; } = Guid.NewGuid().ToString();
    public KbTarget Kb { get; }
    public SemiontClient Client { get; }
    public StateValue<string?> Token { get; }
    public StateValue<UserResponse?> User { get; }
    public StateValue<ConnectionState> StreamState { get; }
    public double? ExpiresAt => Token.Value is { } token ? Tokens.TokenExpiry(token) : null;

    /// <summary>
    /// A script's session over a kept sign-in, with the client it is made over. It renews through
    /// <paramref name="kept"/>, and its client's transport carries the token the session holds. A sign-in that cannot be
    /// read as the session is made is this call's failure. The session asks the gateway who its token is, unless it is
    /// told not to <paramref name="validate"/>. Given a <paramref name="storage"/>, the client keeps the queries
    /// protocol/specs/src/client/refresh.json marks persisted there, for the person <paramref name="kept"/> names as the
    /// session is made, whose kept documents its caches hold from the start, or else for the person the gateway names
    /// once that is recorded on <paramref name="kept"/>; it writes only while <paramref name="kept"/> still names them.
    /// A sign-in it cannot read or record ends that keeping, said on <see cref="Errors"/> as session.keep-failed, and
    /// each write the storage refuses is said there as session.save-refused. Ending the opened session ends the client,
    /// waits for its closing save, and then ends the session, so what that save says reaches the session's errors.
    /// </summary>
    public static async Task<OpenedSession> FromKeptAsync(KbTarget kb, ISignInKept kept, ISessionStorage? storage = null,
        HttpClient? httpClient = null, TimeProvider? timeProvider = null, Random? random = null, bool validate = true,
        CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(kb);
        ArgumentNullException.ThrowIfNull(kept);
        if (kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "A session from a kept sign-in requires an HTTP endpoint.");
        var held = await kept.HeldAsync(cancellation).ConfigureAwait(false);
        var errors = new Broadcast<SemiontError>(keepForFirst: true);
        var persistence = storage is null ? null : new CachePersistence(storage, kb.Id, kept, errors.Publish);
        if (persistence is not null && held is { PersonKey: { } named }) persistence.Attach(named);
        var credentials = new KeptSession(endpoint, kept, httpClient, timeProvider, random, errors, validate,
            answered: (token, user, recording) => persistence is null ? Task.CompletedTask : persistence.RecordAsync(token, user, recording));
        HttpTransport? transport = null;
        try
        {
            transport = new HttpTransport(Gateway.Origin(endpoint), credentials.State.Token, BusRegistry.FullClientChannels,
                refresher: credentials.RefreshAsync, httpClient: httpClient, timeProvider: timeProvider, random: random);
            var client = new SemiontClient(transport, persistence);
            var session = new SemiontSession(kb, client, credentials);
            return new OpenedSession(client, async () =>
            {
                // The client first, its closing save awaited: what that save says reaches the session's errors before they end.
                try
                {
                    client.Dispose();
                    await client.Flushed.ConfigureAwait(false);
                }
                finally { session.Dispose(); }
            }, session);
        }
        catch
        {
            credentials.Dispose();
            transport?.Dispose();
            throw;
        }
    }

    internal SemiontSession(KbTarget kb, SemiontClient client, KeptSession kept)
    {
        Kb = kb;
        Client = client;
        this.kept = kept;
        work = new UnitWork(client.Transport.Closed);
        var initial = kept.State;
        Token = new(initial.Token);
        User = new(initial.User);
        StreamState = new(client.State);
        relayed = client.Transport.RelayFailures(kept.Say);
        client.Transport.SetToken(initial.Token);
        work.Run(FollowIdentityAsync);
        work.Run(FollowStreamAsync);
    }

    /// <summary>
    /// The session's one stream of what went wrong: its own errors, each a <see cref="SessionError"/>, and its client's
    /// transport's failures, each said once. What it says before anyone reads it is kept for the first reader. It ends when
    /// the session ends.
    /// </summary>
    public IAsyncEnumerable<SemiontError> Errors(CancellationToken cancellation = default) => kept.Errors(cancellation);

    public async Task ReadyAsync(CancellationToken cancellation = default)
    {
        await kept.ReadyAsync(cancellation).ConfigureAwait(false);
        UpdateIdentity();
    }

    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        var token = await kept.RefreshAsync(refused, cancellation).ConfigureAwait(false);
        UpdateIdentity();
        return token;
    }

    /// <summary>
    /// Tells a registry's factory options what the session says, read from its errors until they end: each of its own
    /// errors to <see cref="SessionFactoryOptions.OnError"/>, the first said once it has ended to the signals as that end,
    /// and each failure its gateway answered 403 to the signals as a permission denied.
    /// </summary>
    internal async Task TellAsync(SessionFactoryOptions options)
    {
        var told = false;
        await foreach (var error in Errors().ConfigureAwait(false))
        {
            if (error is SessionError own)
            {
                if (!told && kept.EndReason is { } ended)
                {
                    told = true;
                    options.Signals.NotifySessionEnded(ended);
                }
                options.OnError(own);
            }
            else if (error.Status == 403) options.Signals.NotifyPermissionDenied(error.Message);
        }
    }

    private async Task FollowIdentityAsync(CancellationToken cancellation)
    {
        await foreach (var _ in kept.States(cancellation).ConfigureAwait(false))
            UpdateIdentity();
    }

    private async Task FollowStreamAsync(CancellationToken cancellation)
    {
        await foreach (var state in Client.Transport.States(cancellation).ConfigureAwait(false))
            StreamState.Set(state);
    }

    internal void UpdateIdentity()
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            var identity = kept.State;
            Client.Transport.SetToken(identity.Token);
            Token.Set(identity.Token);
            User.Set(identity.User);
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            relayed.Dispose();
            try { kept.Dispose(); }
            finally
            {
                Client.Transport.SetToken(null);
                Token.Set(null);
                User.Set(null);
                Token.Close();
                User.Close();
                StreamState.Close();
            }
        }
    }
}
