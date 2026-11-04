using Semiont.Errors;
using Semiont.Http;
using Semiont.State;
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

    public SemiontSession(KbTarget kb, SemiontClient client, KeptSession kept)
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
        UpdateIdentity(kept.State);
    }

    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        var token = await kept.RefreshAsync(refused, cancellation).ConfigureAwait(false);
        UpdateIdentity(kept.State);
        return token;
    }

    private async Task FollowIdentityAsync(CancellationToken cancellation)
    {
        await foreach (var _ in kept.States(cancellation).ConfigureAwait(false))
            UpdateIdentity(kept.State);
    }

    private async Task FollowStreamAsync(CancellationToken cancellation)
    {
        await foreach (var state in Client.Transport.States(cancellation).ConfigureAwait(false))
            StreamState.Set(state);
    }

    private void UpdateIdentity(SessionState identity)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
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
