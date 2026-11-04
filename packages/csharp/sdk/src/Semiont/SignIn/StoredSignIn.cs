using Semiont.Types;

namespace Semiont.SignIn;

public interface ISignInKept
{
    public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default);
    public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default);
    public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default);
    public Task ForgetAsync(CancellationToken cancellation = default);
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
}
