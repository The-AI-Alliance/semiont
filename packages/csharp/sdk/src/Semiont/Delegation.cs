using System.Runtime.CompilerServices;
using Semiont.Types;

namespace Semiont;

/// <summary>The job's identity, progress, retryable setbacks, the frames of its lifecycle that were refused, and its
/// completion.</summary>
public closed record JobEvent<T>
{
    public sealed record Created(JobCreatedResultResponse Value) : JobEvent<T>;
    public sealed record Progress(JobProgress Value) : JobEvent<T>;
    public sealed record Failed(JobFailCommand Value) : JobEvent<T>;

    /// <summary>A frame of a job's progress, completion or failure, refused by its transport or as its channel's: its
    /// channel, and the member and reason of its fault. It names no job, so it may be this job's or another's, and it is
    /// no word of the job: the follower goes on, and its silence goes on being counted. It comes only after
    /// <see cref="Created"/>.</summary>
    public sealed record Refused(string Channel, string Member, FrameRefusalReason Reason) : JobEvent<T>;

    public sealed record Complete(T Value) : JobEvent<T>;
}

/// <summary>A job followed once, by awaiting its completion or reading its lifecycle events.</summary>
public sealed class Delegation<T> : IAsyncEnumerable<JobEvent<T>>
{
    private readonly Running<JobEvent<T>> following;

    internal Delegation(Func<Action<JobEvent<T>>?, CancellationToken, Task<T>> follow) =>
        following = new(async (report, cancellation) => new JobEvent<T>.Complete(await follow(report, cancellation).ConfigureAwait(Spawning.Captures)));

    public IAsyncEnumerator<JobEvent<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default) =>
        following.GetAsyncEnumerator(cancellationToken);

    public async Task<T> CompleteAsync(CancellationToken cancellation = default)
    {
        var terminal = await following.CompleteAsync(cancellation).ConfigureAwait(Spawning.Captures);
        return terminal is JobEvent<T>.Complete(var completion)
            ? completion : throw new InvalidOperationException("A delegation ended without its completion.");
    }

    public TaskAwaiter<T> GetAwaiter() => CompleteAsync().GetAwaiter();
}
