using System.Net;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.SignIn;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed class IssuerTests
{
    private static StoredSession Held() => new()
    {
        Access = "old",
        Refresh = "refresh &+=",
        ClientId = SignInPolicy.ScriptClientId,
        TokenEndpoint = "https://issuer.example/token",
    };

    [Fact]
    public async Task RefreshUsesTheStoredIssuerAndKeepsAnUnrotatedRefreshToken()
    {
        using var handler = new Handler(async (request, cancellation) =>
        {
            Assert.Equal("https://issuer.example/token", request.RequestUri?.AbsoluteUri);
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Null(request.Headers.Authorization);
            Assert.Equal("application/x-www-form-urlencoded", request.Content?.Headers.ContentType?.MediaType);
            var form = await (request.Content ?? throw new InvalidOperationException("No form")).ReadAsStringAsync(cancellation);
            Assert.Contains("refresh_token=refresh+%26%2B%3D", form, StringComparison.Ordinal);
            Assert.Contains("client_id=" + SignInPolicy.ScriptClientId, form, StringComparison.Ordinal);
            return Answer(200, "{\"access_token\":\"new\"}");
        });
        using var client = new HttpClient(handler);
        var kept = new MemorySignIn(Held());
        using (var issuer = new Issuer(client)) Assert.Equal("new", await issuer.RenewAsync(kept, "old"));
        Assert.Equal("refresh &+=", (await kept.HeldAsync())?.Refresh);
        using var stillUsable = await client.PostAsync("https://issuer.example/token", new FormUrlEncodedContent(new Dictionary<string, string>
        { ["refresh_token"] = "refresh &+=", ["client_id"] = SignInPolicy.ScriptClientId }));
        Assert.Equal(HttpStatusCode.OK, stillUsable.StatusCode);
    }

    [Theory]
    [InlineData(400, "{}")]
    [InlineData(401, "{}")]
    [InlineData(404, "{}")]
    [InlineData(200, "{}")]
    [InlineData(200, "not JSON")]
    [InlineData(200, "{\"access_token\":\"new\",\"refresh_token\":null}")]
    public async Task DefinitiveOrMalformedAnswersAreNotRetried(int status, string body)
    {
        var calls = 0;
        using var handler = new Handler((_, _) => { calls++; return Task.FromResult(Answer(status, body)); });
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client);
        var kept = new MemorySignIn(Held());
        var error = await Assert.ThrowsAsync<SignInError>(() => issuer.RenewAsync(kept, "old"));
        Assert.Equal("exchange", error.Code);
        Assert.Equal(status, error.Status);
        Assert.Equal(1, calls);
        Assert.Equal(Held(), await kept.HeldAsync());
    }

    [Fact]
    public async Task RefreshRetriesUseThePublicClockAndOwnedBudget()
    {
        var clock = new Clock();
        var calls = 0;
        using var handler = new Handler((_, _) => { calls++; return Task.FromResult(Answer(503, "{}")); });
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock, new ZeroRandom());
        var budget = ProtocolFacts.Timing("refreshRetry");
        var attempts = budget.GetProperty("attempts").GetInt32();
        var cap = budget.GetProperty("initialDelayMs").GetDouble();
        var renewal = issuer.RenewAsync(new MemorySignIn(Held()), "old");
        for (var attempt = 1; attempt < attempts; attempt++)
        {
            await clock.WaitForAsync(TimeSpan.FromMilliseconds(cap / 2));
            Assert.Equal(attempt, calls);
            clock.Advance(TimeSpan.FromMilliseconds(cap / 2));
            cap = Math.Min(cap * 2, budget.GetProperty("maxDelayMs").GetDouble());
        }
        await Assert.ThrowsAsync<SignInError>(() => renewal);
        Assert.Equal(attempts, calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CallerCancellationAndDisposalEndAnUnansweredGrant(bool dispose)
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler(async (_, cancellation) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
            throw new InvalidOperationException("An infinite wait returned");
        });
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client);
        using var cancellation = new CancellationTokenSource();
        var renewal = issuer.RenewAsync(new MemorySignIn(Held()), "old", cancellation.Token);
        await entered.Task;
        if (dispose) issuer.Dispose(); else cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => renewal);
    }

    [Fact]
    public void EverySharedRefreshRetryCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/retry/cases.json")));
        foreach (var row in table.RootElement.GetProperty("rules").EnumerateArray().Where(row => row.GetProperty("rule").GetString() == "refresh"))
            Assert.Equal(row.GetProperty("retries").GetBoolean(), ProtocolFacts.RetryRefresh(row.TryGetProperty("status", out var status) ? status.GetInt32() : null));
        Assert.True(ProtocolFacts.RetryRefresh(502));
        Assert.True(ProtocolFacts.RetryRefresh(504));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnUnansweredGrantCanRetryAndRotateTheRefreshToken(bool timeout)
    {
        var clock = new Clock();
        var calls = 0;
        using var handler = new Handler(async (_, cancellation) =>
        {
            if (++calls > 1) return Answer(200, "{\"access_token\":\"new\",\"refresh_token\":\"rotated\"}");
            if (timeout) await Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
            throw new HttpRequestException("unreachable");
        });
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock, new ZeroRandom());
        var kept = new MemorySignIn(Held());
        var renewal = issuer.RenewAsync(kept, "old");
        if (timeout)
        {
            var deadline = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("httpRequestTimeoutMs").GetDouble());
            await clock.WaitForAsync(deadline);
            Assert.False(renewal.IsCompleted);
            clock.Advance(deadline);
        }
        var pause = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("refreshRetry").GetProperty("initialDelayMs").GetDouble() / 2);
        await clock.WaitForAsync(pause);
        Assert.Equal(1, calls);
        clock.Advance(pause);
        Assert.Equal("new", await renewal);
        Assert.Equal("rotated", (await kept.HeldAsync())?.Refresh);
    }

    private static HttpResponseMessage Answer(int status, string body) => new((HttpStatusCode)status) { Content = new StringContent(body) };
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => answer(request, cancellationToken);
    }
    private sealed class ZeroRandom : Random { public override double NextDouble() => 0; }
    private sealed class Clock : TimeProvider
    {
        private readonly FakeTimeProvider fake = new();
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
}
