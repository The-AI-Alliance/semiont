using Semiont.Types;

namespace Semiont.SignIn;

public interface ISignInKept
{
    public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default);
    public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default);
    public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default);
    public Task ForgetAsync(CancellationToken cancellation = default);

    /// <summary>
    /// Records, as one step, the key of the person the gateway named for <paramref name="access"/>: only while the kept
    /// sign-in still holds that access token and names no other person. True when the sign-in then names
    /// <paramref name="personKey"/>; a store that keeps no person answers false.
    /// </summary>
    public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default);
}

public sealed class MemorySignIn(StoredSession? signIn = null) : ISignInKept
{
    private readonly object gate = new();
    private StoredSession? kept = signIn;
    public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default) { cancellation.ThrowIfCancellationRequested(); lock (gate) { return Task.FromResult(kept); } }
    public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default) { cancellation.ThrowIfCancellationRequested(); lock (gate) { kept = signIn; } return Task.CompletedTask; }
    public Task ForgetAsync(CancellationToken cancellation = default) { cancellation.ThrowIfCancellationRequested(); lock (gate) { kept = null; } return Task.CompletedTask; }
    public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            if (kept is null) return Task.FromResult<string?>(null);
            if (kept.Access != read.Access || kept.Refresh != read.Refresh) return Task.FromResult<string?>(kept.Access);
            kept = kept with { Access = access, Refresh = refresh };
            return Task.FromResult<string?>(access);
        }
    }

    public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            if (kept is null || kept.Access != access) return Task.FromResult(false);
            if (kept.PersonKey is { } named) return Task.FromResult(named == personKey);
            kept = kept with { PersonKey = personKey };
            return Task.FromResult(true);
        }
    }
}
