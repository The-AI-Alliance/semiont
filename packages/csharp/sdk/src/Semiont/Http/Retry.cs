using Semiont.Errors;

namespace Semiont.Http;

public static class Retry
{
    public static async Task<T> RetryWithBackoffAsync<T>(RetryPolicy policy, Func<CancellationToken, Task<T>> attempt,
        Func<SemiontError, bool> retryable, Func<SemiontError, TimeSpan?> statedWait,
        TimeProvider? timeProvider = null, Random? random = null, CancellationToken cancellation = default)
    {
        var clock = timeProvider ?? TimeProvider.System;
        var source = random ?? Random.Shared;
        var cap = TimeSpan.FromMilliseconds(policy.InitialDelayMs);
        var maximum = TimeSpan.FromMilliseconds(policy.MaxDelayMs);
        for (var made = 1; ; made++)
        {
            try { return await attempt(cancellation).ConfigureAwait(false); }
            catch (SemiontError error) when (made < policy.Attempts && retryable(error))
            {
                var wait = EqualJitter(cap, source);
                if (statedWait(error) is TimeSpan stated && stated > wait) wait = stated;
                await Task.Delay(wait, clock, cancellation).ConfigureAwait(false);
            }
            cap = cap * 2 < maximum ? cap * 2 : maximum;
        }
    }

    /// <summary>Callers backing off on one schedule do not come back at one instant, and the wait never exceeds <paramref name="cap"/>.</summary>
    internal static TimeSpan EqualJitter(TimeSpan cap, Random random) => cap / 2 + cap / 2 * random.NextDouble();
}
