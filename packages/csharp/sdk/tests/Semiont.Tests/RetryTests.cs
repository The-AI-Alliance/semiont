using System.Text.Json;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Xunit;

namespace Semiont.Tests;

public sealed class RetryTests
{
    [Fact]
    public void EverySdkRetryCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/retry/cases.json")));
        foreach (var row in table.RootElement.GetProperty("rules").EnumerateArray())
        {
            int? status = row.TryGetProperty("status", out var code) ? code.GetInt32() : null;
            var method = row.TryGetProperty("method", out var verb) ? verb.GetString() : null;
            var keyed = row.TryGetProperty("keyed", out var key) && key.GetBoolean();
            var rule = row.GetProperty("rule").GetString();
            if (rule == "job") continue; // This rule belongs to the worker.
            var retries = rule switch
            {
                "boot" => ProtocolFacts.RetryEmit(status ?? throw new InvalidOperationException("Missing boot status")),
                "refresh" => ProtocolFacts.RetryRefresh(status),
                "transport" => ProtocolFacts.RetryTransport(status, method, keyed),
                _ => throw new InvalidOperationException("Unrecognized retry rule: " + rule),
            };
            Assert.Equal(row.GetProperty("retries").GetBoolean(), retries);
        }

        foreach (var row in table.RootElement.GetProperty("retryAfter").EnumerateArray())
        {
            var ms = row.GetProperty("ms");
            Assert.Equal(ms.ValueKind == JsonValueKind.Null ? null : (long?)ms.GetInt64(),
                ProtocolFacts.RetryAfterMilliseconds(row.GetProperty("header").GetString()));
        }

        Assert.True(ProtocolFacts.RetryRefresh(502));
        Assert.True(ProtocolFacts.RetryRefresh(504));
    }

    [Fact]
    public async Task ABudgetIsSpentOnItsDoublingBackoffAndItsLastFailureIsThrownAsItWas()
    {
        var clock = new TestClock();
        var policy = RetryPolicy.FromTiming("refreshRetry");
        var failures = new List<TransportError>();
        var retrying = Retry.RetryWithBackoffAsync(policy, _ =>
        {
            failures.Add(Refused(503));
            return Task.FromException<string>(failures[^1]);
        }, _ => true, _ => null, clock, new ZeroRandom());
        var cap = TimeSpan.FromMilliseconds(policy.InitialDelayMs);
        for (var made = 1; made < policy.Attempts; made++)
        {
            await clock.WaitForAsync(cap / 2);
            Assert.Equal(made, failures.Count);
            clock.Advance(cap / 2);
            cap = cap * 2 < TimeSpan.FromMilliseconds(policy.MaxDelayMs) ? cap * 2 : TimeSpan.FromMilliseconds(policy.MaxDelayMs);
        }
        Assert.Same(failures[^1], await Assert.ThrowsAsync<TransportError>(() => retrying));
        Assert.Equal(policy.Attempts, failures.Count);
    }

    [Fact]
    public async Task AFailureNotWorthAnotherAttemptIsThrownAtOnce()
    {
        var made = 0;
        var refused = Refused(400);
        var thrown = await Assert.ThrowsAsync<TransportError>(() => Retry.RetryWithBackoffAsync(RetryPolicy.FromTiming("refreshRetry"), _ =>
        {
            made++;
            return Task.FromException<string>(refused);
        }, _ => false, _ => null, new TestClock(), new ZeroRandom()));
        Assert.Same(refused, thrown);
        Assert.Equal(1, made);
    }

    [Fact]
    public async Task AFailureThatIsNoSdkErrorIsThrownAtOnce()
    {
        var made = 0;
        await Assert.ThrowsAsync<InvalidOperationException>(() => Retry.RetryWithBackoffAsync(RetryPolicy.FromTiming("refreshRetry"), _ =>
        {
            made++;
            return Task.FromException<string>(new InvalidOperationException("not the SDK's"));
        }, _ => true, _ => null, new TestClock(), new ZeroRandom()));
        Assert.Equal(1, made);
    }

    [Fact]
    public async Task AnAttemptThatSucceedsIsTheAnswer()
    {
        var clock = new TestClock();
        var policy = RetryPolicy.FromTiming("refreshRetry");
        var made = 0;
        var answer = Retry.RetryWithBackoffAsync(policy, _ => ++made < 3 ? Task.FromException<string>(Refused(429)) : Task.FromResult("third time"),
            _ => true, _ => null, clock, new ZeroRandom());
        var cap = TimeSpan.FromMilliseconds(policy.InitialDelayMs);
        for (var waited = 0; waited < 2; waited++)
        {
            await clock.WaitForAsync(cap / 2);
            clock.Advance(cap / 2);
            cap *= 2;
        }
        Assert.Equal("third time", await answer);
        Assert.Equal(3, made);
    }

    [Fact]
    public async Task TheWaitAFailureStatesIsAFloorUnderTheBackoff()
    {
        var clock = new TestClock();
        var policy = RetryPolicy.FromTiming("refreshRetry");
        var stated = TimeSpan.FromMilliseconds(policy.MaxDelayMs) * 2;
        var made = 0;
        var answer = Retry.RetryWithBackoffAsync(policy, _ => ++made == 1 ? Task.FromException<string>(Refused(429)) : Task.FromResult("answered"),
            _ => true, _ => stated, clock, new ZeroRandom());
        await clock.WaitForAsync(stated);
        clock.Advance(stated - TimeSpan.FromTicks(1));
        Assert.Equal(1, made);
        clock.Advance(TimeSpan.FromTicks(1));
        Assert.Equal("answered", await answer);
        Assert.Equal(2, made);
    }

    [Fact]
    public async Task CancellingGivesUpAWaitInProgress()
    {
        var clock = new TestClock();
        var policy = RetryPolicy.FromTiming("refreshRetry");
        using var cancellation = new CancellationTokenSource();
        var made = 0;
        var retrying = Retry.RetryWithBackoffAsync(policy, _ =>
        {
            made++;
            return Task.FromException<string>(Refused(503));
        }, _ => true, _ => null, clock, new ZeroRandom(), cancellation.Token);
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(policy.InitialDelayMs) / 2);
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => retrying);
        Assert.Equal(1, made);
    }

    private static TransportError Refused(int status) => new(ProtocolFacts.Error(status), "refused " + status, status);
}
