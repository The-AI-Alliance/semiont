using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Protocol;

namespace Semiont;

public closed record CacheState<T>
{
    public sealed record Pending : CacheState<T>;
    public sealed record Ready(T Value) : CacheState<T>;
    public sealed record Failed(Exception Error) : CacheState<T>;
}

/// <summary>A live view of a cache key. FreshAsync asks the source for a current answer.</summary>
public abstract class Cached<T> : IAsyncEnumerable<CacheState<T>>
{
    private protected Cached() { }

    public abstract IAsyncEnumerator<CacheState<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default);
    public abstract Task<T> FreshAsync(CancellationToken cancellation = default);
    public abstract void Invalidate();
}

/// <summary>A part of another key's live view: the annotations of a resource's annotations answer.</summary>
internal sealed class CachedPart<TWhole, T>(Cached<TWhole> whole, Func<TWhole, T> part) : Cached<T>
{
    public override async IAsyncEnumerator<CacheState<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default)
    {
        await foreach (var state in whole.WithCancellation(cancellationToken).ConfigureAwait(Spawning.Captures))
        {
            yield return state switch
            {
                CacheState<TWhole>.Pending => new CacheState<T>.Pending(),
                CacheState<TWhole>.Ready(var value) => new CacheState<T>.Ready(part(value)),
                CacheState<TWhole>.Failed(var error) => new CacheState<T>.Failed(error),
            };
        }
    }

    public override async Task<T> FreshAsync(CancellationToken cancellation = default) =>
        part(await whole.FreshAsync(cancellation).ConfigureAwait(Spawning.Captures));

    public override void Invalidate() => whole.Invalidate();
}

/// <summary>A cache's entry for one key.</summary>
internal sealed class CacheEntry<T> : Cached<T>
{
    private readonly object gate = new();
    private readonly Func<CancellationToken, Task<T>> fetch;
    private readonly Func<IDisposable?> hold;
    private readonly TimeProvider clock;
    private readonly TimeSpan window;
    private readonly Action? changed;
    private readonly CancellationTokenSource lifetime = new();
    private readonly CancellationToken stopped;
    private readonly HashSet<ChannelWriter<CacheState<T>>> readers = [];
    private CacheState<T> state = new CacheState<T>.Pending();
    // The key's current fetch, until it settles: the one fetch whose answer is stored.
    private Flight? flight;
    // The flight a validation waits on, which is the current one, and whether it is the validation's second ask.
    private Flight? validation;
    private bool revalidated;
    private bool rehydrated;
    private bool windowOpen;
    private bool owed;
    private bool closed;

    internal CacheEntry(Func<CancellationToken, Task<T>> fetch, Func<IDisposable?> hold, TimeProvider clock, TimeSpan window, Action? changed)
    {
        this.fetch = fetch;
        this.hold = hold;
        this.clock = clock;
        this.window = window;
        this.changed = changed;
        stopped = lifetime.Token;
    }

    public override IAsyncEnumerator<CacheState<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default) =>
        ReadAsync(cancellationToken).GetAsyncEnumerator();

    public override async Task<T> FreshAsync(CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        Task<T> work;
        lock (gate)
        {
            if (closed) throw ClosedError();
            work = Fetch().Answer;
        }
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellation, stopped);
        try { return await Spawning.WaitAsync(work, waiting.Token).ConfigureAwait(Spawning.Captures); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && stopped.IsCancellationRequested)
        {
            throw ClosedError();
        }
    }

    public override void Invalidate()
    {
        lock (gate)
        {
            if (!closed) InvalidateLocked();
        }
    }

    internal void Refresh(bool coalesce = true)
    {
        lock (gate)
        {
            if (!Held()) return;
            if (!coalesce) InvalidateLocked();
            else if (windowOpen) owed = true;
            else OpenWindow();
        }
    }

    internal void Set(T value, bool onlyIfHeld = false)
    {
        lock (gate)
        {
            if (closed || onlyIfHeld && !Held()) return;
            ForgetPreviousValue();
            Ready(value);
        }
    }

    /// <summary>
    /// Writes part of the key's value (B13b): <paramref name="change"/> takes the value to the patched one. It applies at
    /// once to the value the key holds, and is kept with the key's current fetch, whose reply is stored, and given to its
    /// awaiters, through every change kept with it in the order made. A patch lets go of nothing, and leaves a restored
    /// value marked for revalidation. A key with neither a value nor a fetch is not changed.
    /// </summary>
    internal void Patch(Func<T, T> change)
    {
        lock (gate)
        {
            if (closed) return;
            if (state is CacheState<T>.Ready(var value)) Ready(change(value));
            if (flight is { } current) current.Keep(change);
        }
    }

    internal void Remove(bool onlyIfHeld = false)
    {
        lock (gate)
        {
            if (closed || onlyIfHeld && !Held()) return;
            ForgetPreviousValue();
            changed?.Invoke();
            Publish(new CacheState<T>.Failed(new BusRequestError(ProtocolFacts.BusError("not-found"), "The cached item was removed.")));
        }
    }

    private void ForgetPreviousValue()
    {
        rehydrated = false;
        flight = null;
        validation = null;
        owed = false;
    }

    internal bool IsKnown { get { lock (gate) return Held(); } }
    internal CacheState<T>.Ready? CurrentValue { get { lock (gate) return closed ? null : state as CacheState<T>.Ready; } }

    private bool Held() => !closed && (flight is not null || state is not CacheState<T>.Pending);

    private async IAsyncEnumerable<CacheState<T>> ReadAsync([EnumeratorCancellation] CancellationToken cancellation)
    {
        var channel = Channel.CreateUnbounded<CacheState<T>>(new UnboundedChannelOptions { SingleReader = true });
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellation, stopped);
        IDisposable? retained = null;
        lock (gate)
        {
            if (closed || cancellation.IsCancellationRequested) yield break;
            try { retained = hold(); }
            catch (ObjectDisposedException) { yield break; }
            if (state is CacheState<T>.Failed) Publish(new CacheState<T>.Pending());
            readers.Add(channel.Writer);
            channel.Writer.TryWrite(state);
            if ((state is CacheState<T>.Pending || rehydrated) && validation is null) Validate();
        }

        using (retained)
        {
            try
            {
                while (await ReadableAsync(channel.Reader, waiting.Token).ConfigureAwait(Spawning.Captures))
                {
                    if (waiting.IsCancellationRequested) yield break;
                    if (channel.Reader.TryRead(out var value)) yield return value;
                }
            }
            finally
            {
                lock (gate) readers.Remove(channel.Writer);
                channel.Writer.TryComplete();
            }
        }
    }

    private static async ValueTask<bool> ReadableAsync(ChannelReader<CacheState<T>> reader, CancellationToken cancellation)
    {
        try { return await reader.WaitToReadAsync(cancellation).ConfigureAwait(Spawning.Captures); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return false; }
    }

    private void Publish(CacheState<T> value)
    {
        state = value;
        foreach (var reader in readers) reader.TryWrite(value);
    }

    private void Ready(T value)
    {
        changed?.Invoke();
        Publish(new CacheState<T>.Ready(value));
    }

    internal void Rehydrate(T value)
    {
        lock (gate)
        {
            if (closed || Held()) return;
            state = new CacheState<T>.Ready(value);
            rehydrated = true;
        }
    }

    internal bool Fetching { get { lock (gate) return flight is not null; } }

    /// <summary>The key's B19 window is open and holds an invalidation it has not yet run.</summary>
    internal bool RefetchOwed { get { lock (gate) return windowOpen && owed; } }

    /// <summary>The key's current fetch, asked if it has none.</summary>
    private Flight Fetch()
    {
        if (flight is { } current) return current;
        var asked = new Flight();
        flight = asked;
        rehydrated = false;
        _ = Spawning.Run(() => LoadAsync(asked));
        _ = ObserveFailureAsync(asked.Answer);
        return asked;
    }

    private static async Task ObserveFailureAsync(Task work) => await work.ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));

    private async Task LoadAsync(Flight mine)
    {
        try
        {
            stopped.ThrowIfCancellationRequested();
            var value = await fetch(stopped).ConfigureAwait(Spawning.Captures);
            Finish(current =>
            {
                if (closed) mine.Result.TrySetException(ClosedError());
                else if (current)
                {
                    var patched = mine.Patched(value);
                    Ready(patched);
                    mine.Result.TrySetResult(patched);
                }
                else mine.Result.TrySetResult(value);
            }, null);
        }
        catch (OperationCanceledException error) { Finish(_ => mine.Result.TrySetCanceled(error.CancellationToken), null); }
        catch (Exception error) { Finish(_ => mine.Result.TrySetException(error), error); }

        // Only the key's current fetch writes, through the patches kept with it. One that an invalidate, a write, a
        // removal or the closing let go of answers whoever awaited it with its own reply, and stores nothing.
        void Finish(Action<bool> settle, Exception? failure)
        {
            lock (gate)
            {
                var current = flight == mine;
                if (current) flight = null;
                settle(current);
                if (validation == mine) Validated(failure);
            }
        }
    }

    private void Validate()
    {
        revalidated = false;
        validation = Fetch();
    }

    /// <summary>Ends a validation in the step that settles the flight it waits on. A first ask that fails is asked once
    /// more in that step, so the key is never at rest between the two asks; a second that fails fails a key that holds
    /// no value.</summary>
    private void Validated(Exception? failure)
    {
        validation = null;
        if (failure is null || closed) return;
        if (!revalidated)
        {
            revalidated = true;
            validation = Fetch();
            return;
        }
        if (state is CacheState<T>.Pending) Publish(new CacheState<T>.Failed(failure));
    }

    private void InvalidateLocked()
    {
        flight = null;
        if (state is CacheState<T>.Failed) Publish(new CacheState<T>.Pending());
        Validate();
    }

    private void OpenWindow()
    {
        windowOpen = true;
        InvalidateLocked();
        _ = CloseWindowAsync();
    }

    private async Task CloseWindowAsync()
    {
        try { await Task.Delay(window, clock, stopped).ConfigureAwait(Spawning.Captures); }
        catch (OperationCanceledException) when (stopped.IsCancellationRequested) { return; }
        lock (gate)
        {
            if (closed) return;
            windowOpen = false;
            if (!owed) return;
            owed = false;
            if (Held()) OpenWindow();
        }
    }

    internal void Close()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            ForgetPreviousValue();
            foreach (var reader in readers) reader.TryComplete();
            readers.Clear();
        }
        try { lifetime.Cancel(); }
        finally { lifetime.Dispose(); }
    }

    private static BusRequestError ClosedError() => new(ProtocolFacts.BusError("closed"), "The cache is closed.");

    /// <summary>One fetch of the key, and the patches made while it is the key's current fetch, in the order made. They
    /// go with it: a fetch replaced, let go of or failed applies none.</summary>
    private sealed class Flight
    {
        private readonly List<Func<T, T>> patches = [];
        internal TaskCompletionSource<T> Result { get; } = new(Spawning.CompletionOptions);
        internal Task<T> Answer => Result.Task;
        internal void Keep(Func<T, T> change) => patches.Add(change);
        internal T Patched(T reply) => patches.Aggregate(reply, (value, change) => change(value));
    }
}
