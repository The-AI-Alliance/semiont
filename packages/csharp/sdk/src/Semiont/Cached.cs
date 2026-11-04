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
public sealed class Cached<T> : IAsyncEnumerable<CacheState<T>>
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
    private Task<T>? flight;
    private object? validation;
    private long writeEpoch;
    private long written;
    private int activeLoads;
    private bool rehydrated;
    private bool windowOpen;
    private bool owed;
    private bool closed;

    internal Cached(Func<CancellationToken, Task<T>> fetch, Func<IDisposable?> hold, TimeProvider clock, TimeSpan window, Action? changed)
    {
        this.fetch = fetch;
        this.hold = hold;
        this.clock = clock;
        this.window = window;
        this.changed = changed;
        stopped = lifetime.Token;
    }

    public IAsyncEnumerator<CacheState<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default) =>
        ReadAsync(cancellationToken).GetAsyncEnumerator();

    public async Task<T> FreshAsync(CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        Task<T> work;
        lock (gate)
        {
            if (closed) throw ClosedError();
            work = Fetch();
        }
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellation, stopped);
        try { return await work.WaitAsync(waiting.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && stopped.IsCancellationRequested)
        {
            throw ClosedError();
        }
    }

    public void Invalidate()
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

    internal void UpdateIfReady(Func<T, T> update)
    {
        lock (gate)
        {
            if (!closed && state is CacheState<T>.Ready(var value))
            {
                ForgetPreviousValue();
                Ready(update(value));
            }
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
        writeEpoch++;
        rehydrated = false;
        flight = null;
        validation = null;
        owed = false;
    }

    internal bool IsKnown { get { lock (gate) return Held(); } }
    internal CacheState<T>.Ready? CurrentValue { get { lock (gate) return closed ? null : state as CacheState<T>.Ready; } }

    private bool Held() => !closed && (flight is not null || validation is not null || state is not CacheState<T>.Pending);

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
                while (await ReadableAsync(channel.Reader, waiting.Token).ConfigureAwait(false))
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
        try { return await reader.WaitToReadAsync(cancellation).ConfigureAwait(false); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return false; }
    }

    private void Publish(CacheState<T> value)
    {
        state = value;
        foreach (var reader in readers) reader.TryWrite(value);
    }

    private void Ready(T value)
    {
        written = clock.GetUtcNow().UtcTicks;
        changed?.Invoke();
        Publish(new CacheState<T>.Ready(value));
    }

    internal void Rehydrate(T value, long savedAt)
    {
        lock (gate)
        {
            if (closed) return;
            state = new CacheState<T>.Ready(value);
            written = savedAt;
            rehydrated = true;
        }
    }

    internal bool Snapshot(bool requireIdle, out CacheState<T>.Ready? value, out long savedAt)
    {
        lock (gate)
        {
            value = state as CacheState<T>.Ready;
            savedAt = written;
            return !requireIdle || activeLoads == 0 && validation is null && !owed;
        }
    }

    private Task<T> Fetch()
    {
        if (flight is not null) return flight;
        var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        flight = result.Task;
        rehydrated = false;
        activeLoads++;
        var epoch = writeEpoch;
        _ = Task.Run(() => LoadAsync(result, epoch));
        _ = ObserveFailureAsync(result.Task);
        return result.Task;
    }

    private static async Task ObserveFailureAsync(Task work) => await work.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);

    private async Task LoadAsync(TaskCompletionSource<T> result, long epoch)
    {
        try
        {
            stopped.ThrowIfCancellationRequested();
            var value = await fetch(stopped).ConfigureAwait(false);
            Finish(() =>
            {
                if (closed) result.TrySetException(ClosedError());
                else
                {
                    if (epoch == writeEpoch) Ready(value);
                    result.TrySetResult(value);
                }
            });
        }
        catch (OperationCanceledException error) { Finish(() => result.TrySetCanceled(error.CancellationToken)); }
        catch (Exception error) { Finish(() => result.TrySetException(error)); }

        void Finish(Action settle)
        {
            lock (gate)
            {
                activeLoads--;
                if (flight == result.Task) flight = null;
                settle();
            }
        }
    }

    private void Validate()
    {
        var chain = new object();
        validation = chain;
        _ = ValidateAsync(Fetch(), chain);
    }

    private async Task ValidateAsync(Task<T> work, object chain)
    {
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                try { await work.ConfigureAwait(false); return; }
                catch (OperationCanceledException) { return; }
                catch (Exception error)
                {
                    lock (gate)
                    {
                        if (closed || validation != chain) return;
                        if (attempt > 0)
                        {
                            if (state is CacheState<T>.Pending) Publish(new CacheState<T>.Failed(error));
                            return;
                        }
                        if (flight == work) flight = null;
                        work = Fetch();
                    }
                }
            }
        }
        finally
        {
            lock (gate) if (validation == chain) validation = null;
        }
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
        try { await Task.Delay(window, clock, stopped).ConfigureAwait(false); }
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
}
