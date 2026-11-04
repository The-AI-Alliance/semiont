using Semiont.Protocol;

namespace Semiont.State;

public sealed record SearchState<T>(IReadOnlyList<T> Results, bool IsSearching);

/// <summary>Debounces the typed query and follows the latest settled query's answers.</summary>
public sealed class SearchPipeline<T> : IStateUnit
{
    private readonly UnitWork work = new();
    private readonly Func<string, CancellationToken, IAsyncEnumerable<IReadOnlyList<T>?>> search;
    private readonly TimeProvider clock;
    private readonly TimeSpan debounce;
    private CancellationTokenSource? settling;
    private CancellationTokenSource? following;
    private string? searched;

    public StateValue<string> Query { get; }
    public StateValue<SearchState<T>> State { get; } = new(new SearchState<T>([], false));

    public SearchPipeline(Func<string, CancellationToken, IAsyncEnumerable<IReadOnlyList<T>?>> search,
        TimeSpan? debounce = null, string initialQuery = "", TimeProvider? timeProvider = null)
    {
        this.search = search;
        this.debounce = debounce ?? TimeSpan.FromMilliseconds(ProtocolFacts.Timing("searchDebounceMs").GetInt32());
        ArgumentOutOfRangeException.ThrowIfLessThan(this.debounce, TimeSpan.Zero);
        clock = timeProvider ?? TimeProvider.System;
        Query = new StateValue<string>(initialQuery);
        Schedule(initialQuery);
    }

    public void SetQuery(string value)
    {
        lock (work.Gate)
        {
            if (!work.Active || Query.Value == value) return;
            Query.Set(value);
            Schedule(value);
        }
    }

    private void Schedule(string value)
    {
        settling?.Cancel();
        var next = CancellationTokenSource.CreateLinkedTokenSource(work.Token);
        settling = next;
        work.Run(_ => SettleAsync(value, next));
    }

    private async Task SettleAsync(string value, CancellationTokenSource next)
    {
        try
        {
            await Task.Delay(debounce, clock, next.Token).ConfigureAwait(false);
            lock (work.Gate)
            {
                if (!work.Active || settling != next || searched == value) return;
                searched = value;
                following?.Cancel();
                following = null;
                var wanted = value.Trim();
                State.Set(new SearchState<T>([], wanted.Length != 0));
                if (wanted.Length == 0) return;
                var reading = CancellationTokenSource.CreateLinkedTokenSource(work.Token);
                following = reading;
                work.Run(_ => FollowAsync(wanted, reading));
            }
        }
        finally
        {
            lock (work.Gate)
            {
                if (settling == next) settling = null;
                next.Dispose();
            }
        }
    }

    private async Task FollowAsync(string query, CancellationTokenSource reading)
    {
        try
        {
            await foreach (var results in search(query, reading.Token).WithCancellation(reading.Token).ConfigureAwait(false))
            {
                lock (work.Gate)
                {
                    if (!work.Active || following != reading) return;
                    State.Set(new SearchState<T>(results is null ? [] : Array.AsReadOnly(results.ToArray()), results is null));
                }
            }
        }
        finally
        {
            lock (work.Gate)
            {
                if (following == reading)
                {
                    following = null;
                    if (work.Active && State.Value.IsSearching) State.Set(new SearchState<T>([], false));
                }
                reading.Dispose();
            }
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            Query.Close();
            State.Close();
        }
    }
}
