namespace Semiont.SignIn;

/// <summary>A renewal several refusals wait on: whoever stops waiting does not stop it, and once its owner is disposed it
/// gives no token.</summary>
internal static class SharedRenewal
{
    /// <summary>
    /// The token <paramref name="renewal"/> gives, or what it throws, unless its owner's <paramref name="disposal"/> has
    /// come by the time either ends: then no token, as when the issuer gives none, rather than a cancellation the waiter
    /// never had, whatever becomes of <paramref name="renewal"/>. A waiter whose own <paramref name="cancellation"/> is
    /// cancelled is cancelled alone: <paramref name="renewal"/> goes on for the others.
    /// </summary>
    internal static async Task<string?> AnswerAsync(Task<string?> renewal, Task disposal, CancellationToken cancellation)
    {
        await Spawning.WaitAsync(Spawning.WhenAny(disposal, renewal), cancellation).ConfigureAwait(Spawning.Captures);
        if (disposal.IsCompleted) return null;
        return await renewal.ConfigureAwait(Spawning.Captures);
    }
}
