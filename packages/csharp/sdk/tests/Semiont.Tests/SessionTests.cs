using System.Text.Json;
using System.Net;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed class SessionTests
{
    private static UserResponse User() => JsonSerializer.Deserialize<UserResponse>("{\"did\":\"did:web:kb.example:users:alice\",\"domain\":\"kb.example\",\"email\":null,\"name\":null,\"image\":null}") ?? throw new InvalidOperationException("No user");

    private static MemorySignIn Stored(TestClock clock) => new(new StoredSession
    {
        Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 }),
        Refresh = "refresh",
        ClientId = SignInPolicy.ScriptClientId,
        TokenEndpoint = "https://issuer.example/token",
    });

    [Fact]
    public async Task PublicSessionUsesTheKeptIssuerThenValidatesTheIssuedTokenWithoutAStream()
    {
        var clock = new TestClock();
        var token = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 });
        using var handler = new SessionHandler(token);
        using var client = new HttpClient(handler);
        var kept = new MemorySignIn(new StoredSession
        {
            Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() - 1 }),
            Refresh = "refresh",
            ClientId = SignInPolicy.ScriptClientId,
            TokenEndpoint = "https://issuer.example/token",
        });
        var endpoint = JsonSerializer.Deserialize<HttpEndpoint>("{\"kind\":\"http\",\"host\":\"kb.example\",\"port\":443,\"protocol\":\"https\"}") ?? throw new InvalidOperationException("No endpoint");
        using (var session = new KeptSession(endpoint, kept, client, clock, new ZeroRandom()))
        {
            await session.ReadyAsync();
            Assert.Equal(token, session.State.Token);
            Assert.Equal(User(), session.State.User);
            Assert.Equal(new[] { "https://issuer.example/token", "https://kb.example/api/users/me" }, handler.Requests);
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://kb.example/api/users/me");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var response = await client.SendAsync(request);
        Assert.True(response.IsSuccessStatusCode);
        Assert.NotNull(await kept.HeldAsync());
    }

    [Fact]
    public void AnInvalidGatewayIsRefusedBeforeTheSessionStarts()
    {
        var endpoint = JsonSerializer.Deserialize<HttpEndpoint>("{\"kind\":\"http\",\"host\":\"kb.example/path\",\"port\":443,\"protocol\":\"https\"}") ?? throw new InvalidOperationException("No endpoint");
        var error = Assert.Throws<SessionError>(() => { using var session = new KeptSession(endpoint, new MemorySignIn()); });
        Assert.Equal("session.construct-failed", error.Code);
    }

    private sealed class SessionHandler(string token) : HttpMessageHandler
    {
        internal List<string> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri?.AbsoluteUri ?? throw new InvalidOperationException("No URI"));
            if (request.RequestUri.Host == "issuer.example")
            {
                Assert.Equal(HttpMethod.Post, request.Method);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { access_token = token })) });
            }
            Assert.Equal("/api/users/me", request.RequestUri.AbsolutePath);
            Assert.Equal(token, request.Headers.Authorization?.Parameter);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(User())) });
        }
    }

    [Fact]
    public async Task ConcurrentRefusalsShareOneRenewalAndCancelOnlyTheirOwnWait()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var issued = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        async Task<string?> Renew(string? holding, CancellationToken cancellation)
        {
            calls++;
            entered.TrySetResult();
            return await issued.Task.WaitAsync(cancellation);
        }
        using var session = new KeptSession(kept, Renew, (_, _) => Task.FromResult(User()), clock, new ZeroRandom());
        await session.ReadyAsync();
        var token = session.State.Token;
        using var cancellation = new CancellationTokenSource();
        var abandoned = session.RefreshAsync(token, cancellation.Token);
        await entered.Task;
        var waiting = session.RefreshAsync(token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
        issued.SetResult("renewed");
        Assert.Equal("renewed", await waiting);
        Assert.Equal("renewed", await session.RefreshAsync(token));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task DisposalCancelsPendingWorkCompletesObserversAndDoesNotForgetTheSignIn()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<string?> Renew(string? holding, CancellationToken cancellation)
        {
            entered.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
            throw new InvalidOperationException("An infinite wait returned");
        }
        using var session = new KeptSession(kept, Renew, (_, _) => Task.FromResult(User()), clock, new ZeroRandom());
        await session.ReadyAsync();
        await using var observer = session.States().GetAsyncEnumerator();
        Assert.True(await observer.MoveNextAsync());
        var next = observer.MoveNextAsync().AsTask();
        var renewal = session.RefreshAsync(session.State.Token);
        await entered.Task;
        var before = session.State;
        session.Dispose();
        session.Dispose();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => renewal);
        Assert.False(await next);
        Assert.Equal(before, session.State);
        Assert.NotNull(await kept.HeldAsync());
    }

    [Fact]
    public async Task ARefusalDuringStartupAdoptsTheStartsRenewal()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var validating = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refuse = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var asks = 0;
        var renewals = 0;
        async Task<UserResponse> Validate(string token, CancellationToken cancellation)
        {
            if (++asks > 1) return User();
            validating.SetResult();
            await refuse.Task.WaitAsync(cancellation);
            throw new TransportError(ProtocolFacts.Error(401), "refused");
        }
        using var session = new KeptSession(kept, (_, _) => { renewals++; return Task.FromResult<string?>("renewed"); }, Validate, clock, new ZeroRandom());
        await validating.Task;
        var waiting = session.RefreshAsync(session.State.Token);
        refuse.SetResult();
        Assert.Equal("renewed", await waiting);
        Assert.Equal(1, renewals);
        Assert.Equal(2, asks);
    }

    [Fact]
    public async Task ProactiveRenewalUsesThePublicClockAndAsksNobody()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var asks = 0;
        var renewed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var session = new KeptSession(kept, (_, _) =>
        {
            renewed.TrySetResult();
            return Task.FromResult<string?>(TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 }));
        }, (_, _) => { asks++; return Task.FromResult(User()); }, clock, new ZeroRandom());
        await session.ReadyAsync();
        var before = session.State.Token;
        var delay = TimeSpan.FromSeconds(Tokens.RefreshDelay(before ?? throw new InvalidOperationException("No token"), clock.GetUtcNow().ToUnixTimeSeconds()) ?? throw new InvalidOperationException("No schedule"));
        await clock.WaitForAsync(delay);
        Assert.False(renewed.Task.IsCompleted);
        clock.Advance(delay);
        await renewed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => session.State.Token != before);
        Assert.Equal(1, asks);
    }

    [Theory]
    [InlineData("startup")]
    [InlineData("refusal")]
    public async Task EveryLifecycleCaseRuns(string part)
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/session/cases.json")));
        foreach (var row in table.RootElement.GetProperty(part).EnumerateArray())
        {
            var clock = new TestClock();
            var asks = 0;
            var renewals = 0;
            var running = false;
            var gateway = row.GetProperty("gateway").EnumerateArray().Select(value => value.GetString()).ToArray();
            var issuer = row.GetProperty("issuer").EnumerateArray().Select(value => value.GetString()).ToArray();
            string Token(bool expired = false) => TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + (expired ? -3600 : 3600), sub = "alice" });
            var stored = part == "startup" ? row.GetProperty("stored").GetString() : "unexpired";
            var original = new StoredSession { Access = Token(stored == "expired"), Refresh = "refresh", ClientId = SignInPolicy.ScriptClientId, TokenEndpoint = "https://issuer.example/token" };
            var kept = new MemorySignIn(stored == "none" ? null : original);
            Task<UserResponse> Validate(string token, CancellationToken cancellation)
            {
                cancellation.ThrowIfCancellationRequested();
                if (part == "refusal" && !running) return Task.FromResult(User());
                var answer = gateway[Math.Min(asks++, gateway.Length - 1)];
                return answer switch
                {
                    "accepts" => Task.FromResult(User()),
                    "refuses" => throw new TransportError(ProtocolFacts.Error(401), "refused"),
                    "unreachable" => throw new TransportError(ProtocolFacts.Error(503), "unreachable"),
                    _ => throw new InvalidOperationException("Unknown gateway answer"),
                };
            }
            async Task<string?> Renew(string? holding, CancellationToken cancellation)
            {
                var answer = issuer[Math.Min(renewals++, issuer.Length - 1)];
                if (answer == "refuses") throw new SignInError("exchange", "refused", 400);
                if (answer == "unreachable") throw new SignInError("exchange", "unreachable");
                Assert.Equal("renews", answer);
                var renewed = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600, sub = "alice", renewal = renewals });
                var found = await kept.HeldAsync(cancellation);
                if (found is null) return null;
                return await kept.RenewedAsync(found, renewed, "refresh-" + renewals, cancellation);
            }
            using var session = new KeptSession(kept, Renew, Validate, clock, new ZeroRandom());
            await using var errors = session.Errors().GetAsyncEnumerator();
            var errorRead = errors.MoveNextAsync().AsTask();
            try
            {
                await session.ReadyAsync();
                running = true;
                if (part == "refusal")
                {
                    var given = await session.RefreshAsync(session.State.Token);
                    Assert.Equal(row.GetProperty("given").GetBoolean(), given is not null);
                }
                Assert.Equal(row.GetProperty("asks").GetInt32(), asks);
                Assert.Equal(row.GetProperty("renewals").GetInt32(), renewals);
                static string End(KeptSession session) => session.State.Token is null ? "signed-out" : session.State.User is null ? "unconfirmed" : "signed-in";
                Assert.Equal(row.GetProperty("ends").GetString(), End(session));
                Assert.Equal(row.GetProperty("kept").GetBoolean(), await kept.HeldAsync() is not null);
                Assert.Equal(row.GetProperty("told").ValueKind == JsonValueKind.Null ? null : row.GetProperty("told").GetString(), session.EndReason);
                if (row.GetProperty("error").ValueKind != JsonValueKind.Null)
                {
                    Assert.True(await errorRead.WaitAsync(TimeSpan.FromSeconds(10)));
                    Assert.Equal(row.GetProperty("error").GetString(), errors.Current.Code);
                }
                else Assert.False(errorRead.IsCompleted);
                if (row.TryGetProperty("then", out var next))
                {
                    var pause = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("reconnectMs").GetDouble() / 2);
                    await clock.WaitForAsync(pause);
                    clock.Advance(pause);
                    await EventuallyAsync(() => renewals == next.GetProperty("renewals").GetInt32() && asks == next.GetProperty("asks").GetInt32() && End(session) == next.GetProperty("ends").GetString());
                }
            }
            finally
            {
                // Finish the pending MoveNext before the enumerator is disposed.
                session.Dispose();
                await errorRead;
            }
        }
    }

    private static async Task EventuallyAsync(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition()) await Task.Delay(1, deadline.Token);
    }

    private sealed class ZeroRandom : Random { public override double NextDouble() => 0; }

}
