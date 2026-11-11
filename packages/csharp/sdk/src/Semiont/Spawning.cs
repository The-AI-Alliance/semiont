// Every namespace is named, the implicit ones too: the census tests compile this file on its own.
using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Semiont;

/// <summary>
/// Where the SDK's work starts and resumes, and how it waits on more than one thing. An application never sets
/// <see cref="OnCase"/>, and there each member is the call it stands for. A test that plays a case on a
/// SynchronizationContext of its own, one thread running one queue, each callback in a turn of its own, sets it for
/// the case's flow. On such a turn each member keeps the case's work on the case's context, so that once its queue is
/// empty, nothing the case made ready is left to run anywhere.
/// </summary>
internal static class Spawning
{
    /// <summary>Set by a test for the flow it plays a case in: whether the current SynchronizationContext is a turn of
    /// that case's context.</summary>
    internal static readonly AsyncLocal<Func<bool>?> OnCase = new();

    /// <summary>Whether an await resumes on the context it began on: on a case's turn, and nowhere else.</summary>
    internal static bool Captures => OnCase.Value is { } onCase && onCase();

    /// <summary><paramref name="options"/>, resuming on the context the await began on where <see cref="Captures"/>.</summary>
    internal static ConfigureAwaitOptions Options(ConfigureAwaitOptions options) =>
        Captures ? options | ConfigureAwaitOptions.ContinueOnCapturedContext : options;

    /// <summary>
    /// How a completion the SDK makes runs what awaits it: never inside the code that completes it. On a case's turn, a
    /// continuation captured in an earlier turn is queued anyway, and there a completion runs its continuations as it
    /// completes, since the BCL invokes a combinator over one that runs them asynchronously through the thread pool.
    /// </summary>
    internal static TaskCreationOptions CompletionOptions =>
        Captures ? TaskCreationOptions.None : TaskCreationOptions.RunContinuationsAsynchronously;

    internal static Task Run(Func<Task> work) => Captures ? OnTurn(work, CancellationToken.None) : Task.Run(work);

    internal static Task<T> Run<T>(Func<Task<T>> work) => Captures ? OnTurn(work, CancellationToken.None) : Task.Run(work);

    internal static Task<T> Run<T>(Func<Task<T>> work, CancellationToken cancellation) =>
        Captures ? OnTurn(work, cancellation) : Task.Run(work, cancellation);

    /// <summary>What <paramref name="reader"/> holds, as ChannelReader.ReadAllAsync reads it; on a case, by awaits
    /// that resume there, where that iterator's own do not.</summary>
    internal static IAsyncEnumerable<T> ReadAll<T>(ChannelReader<T> reader, CancellationToken cancellation) =>
        Captures ? ReadOnCase(reader, cancellation) : reader.ReadAllAsync(cancellation);

    /// <summary><paramref name="pending"/> as a task; on a case, an await of it that resumes there. ValueTask.AsTask
    /// of a channel's or an iterator's step registers with no context.</summary>
    internal static Task<T> AsTask<T>(ValueTask<T> pending) => Captures ? AwaitOnCase(pending) : pending.AsTask();

    /// <summary>
    /// Cancels <paramref name="source"/>. CancelAsync runs the callbacks on the thread pool; on a case they run at once,
    /// on the case's thread, and what they resume was captured in an earlier turn, so it is queued, as it would be.
    /// </summary>
    internal static Task CancelAsync(CancellationTokenSource source)
    {
        if (!Captures) return source.CancelAsync();
        source.Cancel();
        return Task.CompletedTask;
    }

    /// <summary>The first of <paramref name="tasks"/> to end. On a case, an await of each that resumes there finds it:
    /// the BCL invokes Task.WhenAny's promise through the thread pool, with no execution context, for a task that runs
    /// its continuations asynchronously, as a Task.Delay does once its token is cancelled.</summary>
    internal static Task<Task> WhenAny(params IReadOnlyList<Task> tasks) => Captures ? FirstOnCase(tasks) : Task.WhenAny(tasks);

    /// <summary>Once all of <paramref name="tasks"/> have ended; on a case, after an await of each that resumes there.</summary>
    internal static Task WhenAll(params IReadOnlyList<Task> tasks) => Captures ? AllOnCase(tasks) : Task.WhenAll(tasks);

    /// <summary>The results of <paramref name="tasks"/>, once all have ended; on a case, after an await of each that
    /// resumes there.</summary>
    internal static Task<T[]> WhenAll<T>(IEnumerable<Task<T>> tasks) => Captures ? AllOnCase<T>([.. tasks]) : Task.WhenAll(tasks);

    /// <summary><paramref name="task"/>, or its cancellation by <paramref name="cancellation"/> if that comes first; on a
    /// case, found by an await of it that resumes there and a registration that runs where the token is cancelled.</summary>
    internal static Task WaitAsync(Task task, CancellationToken cancellation) =>
        Captures ? WaitOnCase(task, cancellation) : task.WaitAsync(cancellation);

    /// <summary><paramref name="task"/>, or its cancellation by <paramref name="cancellation"/> if that comes first; on a
    /// case, found by an await of it that resumes there and a registration that runs where the token is cancelled.</summary>
    internal static Task<T> WaitAsync<T>(Task<T> task, CancellationToken cancellation) =>
        Captures ? WaitOnCase(task, cancellation) : task.WaitAsync(cancellation);

    /// <summary>Parallel.ForEachAsync, whose workers, on a case, are scheduled on the case's context.</summary>
    internal static Task ForEachAsync<T>(IEnumerable<T> source, ParallelOptions options, Func<T, CancellationToken, ValueTask> body)
    {
        if (Captures) options.TaskScheduler = TaskScheduler.FromCurrentSynchronizationContext();
        return Parallel.ForEachAsync(source, options, body);
    }

    private static Task OnTurn(Func<Task> work, CancellationToken cancellation) =>
        Task.Factory.StartNew(work, cancellation, TaskCreationOptions.DenyChildAttach, TaskScheduler.FromCurrentSynchronizationContext()).Unwrap();

    private static Task<T> OnTurn<T>(Func<Task<T>> work, CancellationToken cancellation) =>
        Task.Factory.StartNew(work, cancellation, TaskCreationOptions.DenyChildAttach, TaskScheduler.FromCurrentSynchronizationContext()).Unwrap();

    private static async IAsyncEnumerable<T> ReadOnCase<T>(ChannelReader<T> reader, [EnumeratorCancellation] CancellationToken cancellation)
    {
        while (await reader.WaitToReadAsync(cancellation).ConfigureAwait(true))
            while (reader.TryRead(out var item)) yield return item;
    }

    private static async Task<T> AwaitOnCase<T>(ValueTask<T> pending) => await pending.ConfigureAwait(true);

    private static Task<Task> FirstOnCase(IReadOnlyList<Task> tasks)
    {
        var first = new TaskCompletionSource<Task>();
        foreach (var task in tasks) _ = Relay(task, first);
        return first.Task;

        static async Task Relay(Task task, TaskCompletionSource<Task> first)
        {
            await Ended(task);
            first.TrySetResult(task);
        }
    }

    private static async Task AllOnCase(IReadOnlyList<Task> tasks)
    {
        foreach (var task in tasks) await Ended(task);
        await Task.WhenAll(tasks).ConfigureAwait(true);
    }

    private static async Task<T[]> AllOnCase<T>(IReadOnlyList<Task<T>> tasks)
    {
        foreach (var task in tasks) await Ended(task);
        return await Task.WhenAll(tasks).ConfigureAwait(true);
    }

    private static Task WaitOnCase(Task task, CancellationToken cancellation)
    {
        if (task.IsCompleted || !cancellation.CanBeCanceled) return task;
        if (cancellation.IsCancellationRequested) return Task.FromCanceled(cancellation);
        var waited = new TaskCompletionSource();
        var registration = cancellation.Register(() => waited.TrySetCanceled(cancellation));
        _ = Relay(task, waited, registration);
        return waited.Task;

        static async Task Relay(Task task, TaskCompletionSource waited, CancellationTokenRegistration registration)
        {
            await Ended(task);
            registration.Dispose();
            waited.TrySetFromTask(task);
        }
    }

    private static Task<T> WaitOnCase<T>(Task<T> task, CancellationToken cancellation)
    {
        if (task.IsCompleted || !cancellation.CanBeCanceled) return task;
        if (cancellation.IsCancellationRequested) return Task.FromCanceled<T>(cancellation);
        var waited = new TaskCompletionSource<T>();
        var registration = cancellation.Register(() => waited.TrySetCanceled(cancellation));
        _ = Relay(task, waited, registration);
        return waited.Task;

        static async Task Relay(Task<T> task, TaskCompletionSource<T> waited, CancellationTokenRegistration registration)
        {
            await Ended(task);
            registration.Dispose();
            waited.TrySetFromTask(task);
        }
    }

    /// <summary>An await of <paramref name="task"/> that ends when it does, however it ends, and resumes on the context it
    /// began on.</summary>
    private static ConfiguredTaskAwaitable Ended(Task task) =>
        task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing | ConfigureAwaitOptions.ContinueOnCapturedContext);
}
