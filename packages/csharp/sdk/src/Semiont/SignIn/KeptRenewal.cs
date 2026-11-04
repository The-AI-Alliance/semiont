using Semiont.Session;
using Semiont.Types;

namespace Semiont.SignIn;

internal static class KeptRenewal
{
    internal static async Task<string?> RenewAsync(ISignInKept kept, string? holding,
        Func<StoredSession, CancellationToken, Task<(string Access, string? Refresh)>> grant,
        TimeProvider clock, CancellationToken cancellation = default)
    {
        var read = await kept.HeldAsync(cancellation).ConfigureAwait(false);
        if (read is null) return null;
        if (read.Access != holding && !Tokens.IsTokenExpired(read.Access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d)) return read.Access;
        var issued = await grant(read, cancellation).ConfigureAwait(false);
        return await kept.RenewedAsync(read, issued.Access, issued.Refresh ?? read.Refresh, cancellation).ConfigureAwait(false);
    }
}
