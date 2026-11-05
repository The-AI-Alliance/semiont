namespace Semiont.Tests;

/// <summary>A clock the table runner advances one due instant at a time.</summary>
internal sealed class StateCaseClock : TimeProvider
{
    private readonly object gate = new();
    private readonly List<Timer> timers = [];
    private long now;

    public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddTicks(GetTimestamp());
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    public override long GetTimestamp() { lock (gate) return now; }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new Timer(this, callback, state);
        timer.Change(dueTime, period);
        return timer;
    }

    internal bool FireNext(long target)
    {
        Timer? due;
        lock (gate)
        {
            due = timers.Where(timer => timer.At <= target).MinBy(timer => timer.At);
            if (due is null) { now = target; return false; }
            now = due.At;
            if (due.Period <= TimeSpan.Zero) timers.Remove(due);
            else due.At += due.Period.Ticks;
        }
        due.Fire();
        return true;
    }

    private sealed class Timer(StateCaseClock clock, TimerCallback callback, object? state) : ITimer
    {
        private bool closed;
        internal long At { get; set; }
        internal TimeSpan Period { get; private set; }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (clock.gate)
            {
                if (closed) return false;
                clock.timers.Remove(this);
                Period = period;
                if (dueTime != Timeout.InfiniteTimeSpan)
                {
                    At = clock.now + dueTime.Ticks;
                    clock.timers.Add(this);
                }
                return true;
            }
        }

        internal void Fire() => callback(state);

        public void Dispose()
        {
            lock (clock.gate) { closed = true; clock.timers.Remove(this); }
        }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
