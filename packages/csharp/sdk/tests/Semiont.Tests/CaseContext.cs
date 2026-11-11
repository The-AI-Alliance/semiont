using System.Collections.Concurrent;
using System.Diagnostics;

namespace Semiont.Tests;

/// <summary>
/// One thread and one FIFO queue, which a shared state case's work runs on. Each callback runs in a turn of its own, a
/// context that posts to the same queue, so a continuation captured in one turn and resumed in another is always queued,
/// never run inside the code that completed it. The SDK's <see cref="Spawning"/> keeps the case's work on its turns, so
/// once the queue is empty nothing the case made ready is left to run. Work of the case that runs anywhere else is an
/// escape, and fails the case: a thread other than the case's taking up the case's execution context, or posting to its
/// queue, which a hop that carries no execution context still does.
/// </summary>
internal sealed class CaseContext : SynchronizationContext
{
    /// <summary>How long a case may take, on the wall clock, before it fails as hung.</summary>
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(25);

    private readonly object gate = new();
    private readonly Queue<(SendOrPostCallback Callback, object? State)> queue = new();
    private readonly ConcurrentQueue<string> escapes = new();
    private readonly AsyncLocal<CaseContext?> marked;
    private readonly Thread thread;
    private bool ended;

    private CaseContext()
    {
        marked = new AsyncLocal<CaseContext?>(Changed);
        thread = new Thread(Loop) { IsBackground = true, Name = "case" };
    }

    /// <summary>
    /// Plays <paramref name="body"/> on a context of its own. The case fails, naming the first escape and its stack, if
    /// any of its work ran on another thread, and fails as hung if it has not ended within <see cref="Limit"/>.
    /// </summary>
    internal static async Task PlayAsync(Func<CaseContext, Task> body)
    {
        var context = new CaseContext();
        var played = context.Start(body);
        try { await played.WaitAsync(Limit); }
        catch (Exception failure) when (!context.escapes.IsEmpty) { throw context.Escape(failure); }
        catch (TimeoutException) when (!played.IsCompleted) { throw new TimeoutException($"The case did not end within {Limit.TotalSeconds} s"); }
        context.ThrowIfEscaped();
    }

    /// <summary>Whether nothing the case has made ready is left to run.</summary>
    internal bool Idle { get { lock (gate) return queue.Count == 0; } }

    /// <summary>Yields until nothing the case has made ready is left to run, what that made ready included.</summary>
    internal async Task DrainAsync()
    {
        while (!Idle) await Task.Yield();
    }

    /// <summary>Fails the case if any of its work has run on another thread.</summary>
    internal void ThrowIfEscaped()
    {
        if (!escapes.IsEmpty) throw Escape(null);
    }

    public override void Post(SendOrPostCallback d, object? state)
    {
        if (Environment.CurrentManagedThreadId != thread.ManagedThreadId)
            escapes.Enqueue("a post to the case's queue from another thread\n" + new StackTrace(1, false));
        Enqueue(d, state);
    }

    public override void Send(SendOrPostCallback d, object? state) => throw new NotSupportedException("A case's context is never waited on.");

    public override SynchronizationContext CreateCopy() => this;

    private bool IsTurn() => Current is Turn turn && ReferenceEquals(turn.Owner, this);

    private InvalidOperationException Escape(Exception? failure) =>
        new($"Work of the case ran off its thread, {escapes.Count} time(s); the first: {escapes.First()}", failure);

    private Task Start(Func<CaseContext, Task> body)
    {
        var played = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Enqueue(_ => _ = RunAsync(), null);
        thread.Start();
        return played.Task;

        async Task RunAsync()
        {
            marked.Value = this;
            Spawning.OnCase.Value = IsTurn;
            try
            {
                await body(this);
                played.SetResult();
            }
            catch (Exception failure) { played.SetException(failure); }
            finally { lock (gate) { ended = true; Monitor.Pulse(gate); } }
        }
    }

    private void Enqueue(SendOrPostCallback callback, object? state)
    {
        lock (gate)
        {
            if (ended) return;
            queue.Enqueue((callback, state));
            Monitor.Pulse(gate);
        }
    }

    private void Loop()
    {
        while (true)
        {
            (SendOrPostCallback Callback, object? State) next;
            lock (gate)
            {
                while (queue.Count == 0 && !ended) Monitor.Wait(gate);
                if (queue.Count == 0) return;
                next = queue.Dequeue();
            }
            SetSynchronizationContext(new Turn(this));
            next.Callback(next.State);
        }
    }

    private void Changed(AsyncLocalValueChangedArgs<CaseContext?> change)
    {
        if (ReferenceEquals(change.CurrentValue, this) && Environment.CurrentManagedThreadId != thread.ManagedThreadId)
            escapes.Enqueue("the case's execution context taken up by another thread\n" + new StackTrace(1, false));
    }

    private sealed class Turn(CaseContext owner) : SynchronizationContext
    {
        internal CaseContext Owner { get; } = owner;

        public override void Post(SendOrPostCallback d, object? state) => Owner.Post(d, state);

        public override void Send(SendOrPostCallback d, object? state) => throw new NotSupportedException("A case's context is never waited on.");

        public override SynchronizationContext CreateCopy() => this;
    }
}
