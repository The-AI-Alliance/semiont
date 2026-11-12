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
    /// each write the storage refuses is said there as session.save-refused. The session signs out when the issuer refuses
    /// its renewal, or a renewal gives no token, or the gateway refuses a token the issuer has just issued: its sign-in is
    /// forgotten, and <paramref name="onAuthFailed"/> is told why before that is said on <see cref="Errors"/>. Ending the
    /// opened session ends the client, waits for its closing save, and then ends the session, so what that save says
    /// reaches the session's errors.
    /// </summary>
    public static async Task<OpenedSession> FromKeptAsync(KbTarget kb, ISignInKept kept, ISessionStorage? storage = null,
        HttpClient? httpClient = null, TimeProvider? timeProvider = null, Random? random = null, bool validate = true,
        Action<SessionEndReason>? onAuthFailed = null, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(kb);
        ArgumentNullException.ThrowIfNull(kept);
        if (kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "A session from a kept sign-in requires an HTTP endpoint.");
        var held = await kept.HeldAsync(cancellation).ConfigureAwait(Spawning.Captures);
        var errors = new Broadcast<SemiontError>(keptForFirst: SemiontError.KeptForFirstReader);
        var persistence = storage is null ? null : new CachePersistence(storage, kb.Id, kept, errors.Publish);
        if (persistence is not null && held is { PersonKey: { } named }) persistence.Attach(named);
        var credentials = new KeptSession(endpoint, kept, httpClient, timeProvider, random, errors, validate,
            answered: (token, user, recording) => persistence is null ? Task.CompletedTask : persistence.RecordAsync(token, user, recording),
            onAuthFailed: onAuthFailed);
        HttpTransport? transport = null;
        try
        {
            transport = new HttpTransport(Gateway.Origin(endpoint), credentials.State.Token, BusRegistry.BridgedChannels,
                refresher: credentials.RefreshAsync, httpClient: httpClient, timeProvider: timeProvider, random: random);
            var client = new SemiontClient(transport, persistence);
            var session = new SemiontSession(kb, client, credentials);
            return new OpenedSession(client, async () =>
            {
                // The client first, its closing save awaited: what that save says reaches the session's errors before they end.
                try
                {
                    client.Dispose();
                    await client.Flushed.ConfigureAwait(Spawning.Captures);
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
    /// transport's failures, each said once. Of what it says before anyone reads it, the latest errorsKeptForFirstReaderCount
    /// (protocol/specs/src/client/timing.json) are kept for the first reader, in the order said. It ends when the session
    /// ends.
    /// </summary>
    public IAsyncEnumerable<SemiontError> Errors(CancellationToken cancellation = default) => kept.Errors(cancellation);

    public async Task ReadyAsync(CancellationToken cancellation = default)
    {
        await kept.ReadyAsync(cancellation).ConfigureAwait(Spawning.Captures);
        UpdateIdentity();
    }

    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        var token = await kept.RefreshAsync(refused, cancellation).ConfigureAwait(Spawning.Captures);
        UpdateIdentity();
        return token;
    }

    private async Task FollowIdentityAsync(CancellationToken cancellation)
    {
        await foreach (var _ in kept.States(cancellation).ConfigureAwait(Spawning.Captures))
            UpdateIdentity();
    }

    private async Task FollowStreamAsync(CancellationToken cancellation)
    {
        await foreach (var state in Client.Transport.States(cancellation).ConfigureAwait(Spawning.Captures))
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
