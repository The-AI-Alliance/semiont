using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;

namespace Semiont.Tests;

internal sealed class TestClock : TimeProvider
{
    private readonly FakeTimeProvider fake = new(DateTimeOffset.FromUnixTimeSeconds(2000000000));
    private readonly Channel<TimeSpan> timers = Channel.CreateUnbounded<TimeSpan>();
    public override DateTimeOffset GetUtcNow() => fake.GetUtcNow();
    public override long GetTimestamp() => fake.GetTimestamp();
    public override long TimestampFrequency => fake.TimestampFrequency;
    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = fake.CreateTimer(callback, state, dueTime, period);
        timers.Writer.TryWrite(dueTime);
        return timer;
    }
    internal void Advance(TimeSpan elapsed) => fake.Advance(elapsed);
    internal async Task WaitForAsync(TimeSpan due)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await timers.Reader.ReadAsync(deadline.Token) != due) { }
    }
}
