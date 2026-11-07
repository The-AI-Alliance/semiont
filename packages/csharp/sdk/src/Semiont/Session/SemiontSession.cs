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

    public string Id { get; } = Guid.NewGuid().ToString();
    public KbTarget Kb { get; }
    public SemiontClient Client { get; }
    public StateValue<string?> Token { get; }
    public StateValue<UserResponse?> User { get; }
    public StateValue<ConnectionState> StreamState { get; }
    public double? ExpiresAt => Token.Value is { } token ? Tokens.TokenExpiry(token) : null;

    /// <summary>
    /// A script's session over a kept sign-in, with the client it is made over. It renews through
    /// <paramref name="kept"/>, and its client's transport carries the token the session holds. Given a
    /// <paramref name="storage"/>, the client keeps the queries protocol/specs/src/client/refresh.json marks persisted
    /// there, for the person <paramref name="kept"/> names as the session is made, whose kept documents its caches hold
    /// from the start, or else for the person the gateway names once that is recorded on <paramref name="kept"/>; it
    /// writes only while <paramref name="kept"/> still names them. A sign-in it cannot read ends that keeping, and is
    /// told on <see cref="Errors"/> as session.keep-failed. Ending the opened session ends the client, and then the
    /// session, so what the client's closing save tells reaches the session's errors.
    /// </summary>
    public static async Task<OpenedSession> FromKeptAsync(KbTarget kb, ISignInKept kept, ISessionStorage? storage = null,
        HttpClient? httpClient = null, TimeProvider? timeProvider = null, Random? random = null, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(kb);
        ArgumentNullException.ThrowIfNull(kept);
        if (kb.Endpoint is not KbEndpoint.HttpEndpointCase(var endpoint))
            throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "A session from a kept sign-in requires an HTTP endpoint.");
        var errors = new Broadcast<SessionError>(keepForFirst: true);
        var persistence = storage is null ? null : new CachePersistence(storage, kb.Id, kept, errors.Publish);
        if (persistence is not null && await kept.HeldAsync(cancellation).ConfigureAwait(false) is { PersonKey: { } named })
            persistence.Attach(named);
        var credentials = new KeptSession(endpoint, kept, httpClient, timeProvider, random, errors, answered: async (token, user, recording) =>
        {
            if (persistence is null) return;
            var person = RegistryStorage.PersonKey(user.Did);
            if (await kept.RecordPersonKeyAsync(token, person, recording).ConfigureAwait(false)) persistence.Attach(person);
        });
        HttpTransport? transport = null;
        try
        {
            transport = new HttpTransport(Gateway.Origin(endpoint), credentials.State.Token, BusRegistry.FullClientChannels,
                refresher: credentials.RefreshAsync, httpClient: httpClient, timeProvider: timeProvider, random: random);
            var client = new SemiontClient(transport, persistence);
            var session = new SemiontSession(kb, client, credentials);
            return new OpenedSession(client, () =>
            {
                try { client.Dispose(); }
                finally { session.Dispose(); }
                return ValueTask.CompletedTask;
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
        client.Transport.SetToken(initial.Token);
        work.Run(FollowIdentityAsync);
        work.Run(FollowStreamAsync);
    }

    public IAsyncEnumerable<SessionError> Errors(CancellationToken cancellation = default) => kept.Errors(cancellation);

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
