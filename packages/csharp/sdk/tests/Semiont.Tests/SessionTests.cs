using System.Collections.Concurrent;
using System.Text.Json;
using System.Net;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;
using Semiont.Errors;
using Semiont.Http;
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
        using (var session = new KeptSession(endpoint, kept, client, clock, new ZeroRandom(), new Broadcast<SemiontError>(keptForFirst: SemiontError.KeptForFirstReader), validates: true,
            static (_, _, _) => Task.CompletedTask, onAuthFailed: null))
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
        var error = Assert.Throws<SessionError>(() =>
        {
            using var session = new KeptSession(endpoint, new MemorySignIn(), null, new TestClock(), new ZeroRandom(),
                new Broadcast<SemiontError>(keptForFirst: SemiontError.KeptForFirstReader), validates: true, static (_, _, _) => Task.CompletedTask, onAuthFailed: null);
        });
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
        using var session = new KeptSession(kept, Renew, (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), onAuthFailed: null);
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

    // A session disposed while its token is renewed gives the refusal waiting no token at once. The renewal is not ended:
    // an issuer that rotates refresh tokens spent the old one as it answered, so the close waits for the renewal, and the
    // new pair is kept where the sign-in is. The session takes none of it, completes its observers and signs nothing out,
    // and a refusal after the close, of the token it holds or of the one that token replaced, is given none, with nothing
    // renewed.
    [Fact]
    public async Task DisposalGivesTheRefusalNoTokenAtOnceAndWaitsForTheRenewalUnderWayWhoseTokensAreKept()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var stored = (await kept.HeldAsync())?.Access ?? throw new InvalidOperationException("Nothing is stored");
        var renewed = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 7200 });
        var late = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 10800 });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var answer = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var grants = 0;
        async Task<(string Access, string? Refresh)> Grant(StoredSession read, CancellationToken cancellation)
        {
            if (Interlocked.Increment(ref grants) == 1) return (renewed, "refresh-2");
            entered.TrySetResult();
            await answer.Task.WaitAsync(cancellation);
            return (late, "refresh-3");
        }
        var ended = new ConcurrentQueue<SessionEndReason>();
        using var session = new KeptSession(kept, (holding, cancellation) => KeptRenewal.RenewAsync(kept, holding, Grant, clock, cancellation),
            (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), ended.Enqueue);
        await session.ReadyAsync();
        Assert.Equal(renewed, await session.RefreshAsync(stored));
        await using var observer = session.States().GetAsyncEnumerator();
        Assert.True(await observer.MoveNextAsync());
        var next = observer.MoveNextAsync().AsTask();
        var before = session.State;
        var refusing = session.RefreshAsync(renewed);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var closing = session.DisposeAsync().AsTask();
        // A second close is the first.
        session.Dispose();

        // The refusal is given no token at once, rather than a cancellation it never had, and the close waits for the issuer.
        Assert.Null(await refusing.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(await next);
        Assert.False(closing.IsCompleted);
        // The issuer answers: the close returns once the new pair is kept, and the session took none of it.
        answer.SetResult();
        await closing.WaitAsync(TimeSpan.FromSeconds(10));
        var keptNow = await kept.HeldAsync();
        Assert.Equal(late, keptNow?.Access);
        Assert.Equal("refresh-3", keptNow?.Refresh);
        Assert.Equal(before, session.State);
        Assert.Empty(ended);
        // A refusal once disposed, of the token held or of the one it replaced, is given no token, and nothing is renewed.
        Assert.Null(await session.RefreshAsync(renewed));
        Assert.Null(await session.RefreshAsync(stored));
        Assert.Equal(2, Volatile.Read(ref grants));
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
        using var session = new KeptSession(kept, (_, _) => { renewals++; return Task.FromResult<string?>("renewed"); }, Validate, clock, new ZeroRandom(), onAuthFailed: null);
        await validating.Task;
        var waiting = session.RefreshAsync(session.State.Token);
        refuse.SetResult();
        Assert.Equal("renewed", await waiting);
        Assert.Equal(1, renewals);
        Assert.Equal(2, asks);
    }

    [Fact]
    public async Task AFailedStorageWriteIsReportedToSessionObservers()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var failure = new IOException("Storage was read-only.");
        using var session = new KeptSession(kept, (_, _) => Task.FromException<string?>(failure),
            (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), onAuthFailed: null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await session.ReadyAsync(deadline.Token);
        var original = await kept.HeldAsync(deadline.Token);
        Assert.Null(await session.RefreshAsync(session.State.Token, deadline.Token));
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        Assert.True(await errors.MoveNextAsync());
        Assert.Equal("session.refresh-exhausted", errors.Current.Code);
        Assert.Same(failure, errors.Current.InnerException);
        Assert.Equal(original, await kept.HeldAsync(deadline.Token));
    }

    // A session keeps the latest errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json) of what it says
    // before anyone reads its errors, the oldest dropped beyond that: its first reader hears those, in the order said.
    [Fact]
    public async Task TheFirstReaderOfASessionNobodyReadHearsTheLatestItKeptInOrder()
    {
        var clock = new TestClock();
        var most = ProtocolFacts.Timing("errorsKeptForFirstReaderCount").GetInt32();
        using var session = new KeptSession(Stored(clock), (_, _) => Task.FromResult<string?>(null), (_, _) => Task.FromResult(User()),
            clock, new ZeroRandom(), onAuthFailed: null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await session.ReadyAsync(deadline.Token);
        var said = Enumerable.Range(0, most + 3).Select<int, SemiontError>(at => new TransportError(ProtocolFacts.Error(0), $"failure {at}")).ToArray();
        foreach (var error in said) session.Say(error);
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        Assert.True(await errors.MoveNextAsync(), "the first reader heard nothing");
        var heard = new List<SemiontError> { errors.Current };
        // Ending the session ends its errors once what they hold is read, so the reading below stops at the last kept.
        session.Dispose();
        while (await errors.MoveNextAsync()) heard.Add(errors.Current);
        Assert.Equal(said.TakeLast(most), heard);
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
        }, (_, _) => { asks++; return Task.FromResult(User()); }, clock, new ZeroRandom(), onAuthFailed: null);
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

    // A renewal that gives no token while the sign-in is still kept has nothing left to renew with: the session signs out
    // as the issuer's refusal signs it out, its sign-in forgotten, onAuthFailed told it expired, and that said as
    // session.refresh-exhausted.
    [Fact]
    public async Task ARenewalThatGivesNoTokenWhileTheSignInIsKeptSignsOut()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var ended = new ConcurrentQueue<SessionEndReason>();
        using var session = new KeptSession(kept, (_, _) => Task.FromResult<string?>(null), (_, _) => Task.FromResult(User()),
            clock, new ZeroRandom(), ended.Enqueue);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        await session.ReadyAsync(deadline.Token);
        Assert.Null(await session.RefreshAsync(session.State.Token, deadline.Token));
        Assert.True(await errors.MoveNextAsync(), "the session's end was not said");
        Assert.Equal("session.refresh-exhausted", errors.Current.Code);
        Assert.Equal([SessionEndReason.Expired], ended.ToArray());
        Assert.Equal(new SessionState(null, null), session.State);
        Assert.Null(await kept.HeldAsync(deadline.Token));
    }

    // At the start there was no session to end (protocol/specs/src/session/cases.json): a renewal of the expired token
    // found stored that gives no token while the sign-in is still kept forgets it, and tells onAuthFailed and the errors
    // nothing.
    [Fact]
    public async Task AStartsRenewalThatGivesNoTokenWhileTheSignInIsKeptForgetsItAndSaysNothing()
    {
        var clock = new TestClock();
        var kept = new MemorySignIn(new StoredSession
        {
            Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() - 1 }),
            Refresh = "refresh",
            ClientId = SignInPolicy.ScriptClientId,
            TokenEndpoint = "https://issuer.example/token",
        });
        var ended = new ConcurrentQueue<SessionEndReason>();
        using var session = new KeptSession(kept, (_, _) => Task.FromResult<string?>(null), (_, _) => Task.FromResult(User()),
            clock, new ZeroRandom(), ended.Enqueue);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var said = FirstSaidAsync(session.Errors(deadline.Token));
        await session.ReadyAsync(deadline.Token);
        Assert.Null(await kept.HeldAsync(deadline.Token));
        Assert.Empty(ended);
        Assert.Equal(new SessionState(null, null), session.State);
        Assert.False(said.IsCompleted, "the start said something");
    }

    // A renewal that cannot read the sign-in it renews got no answer (protocol/specs/src/session/cases.json): at the start
    // the session says so as session.auth-failed, and on its errors stream; it keeps what is stored, and renews again on
    // the reconnect backoff, each renewal with no answer said as session.refresh-exhausted.
    [Fact]
    public async Task ASignInThatCannotBeReadAtTheStartsRenewalIsARenewalWithNoAnswer()
    {
        var clock = new TestClock();
        var stored = new StoredSession
        {
            Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() - 1 }),
            Refresh = "refresh",
            ClientId = SignInPolicy.ScriptClientId,
            TokenEndpoint = "https://issuer.example/token",
        };
        var signIn = new MemorySignIn(stored);
        var kept = new SignInUnreadableAfter(signIn, reads: 1);
        using var issuer = new Issuer(timeProvider: clock, random: new ZeroRandom());
        using var session = new KeptSession(kept, (holding, cancellation) => issuer.RenewAsync(kept, holding, cancellation),
            (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), onAuthFailed: null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        await session.ReadyAsync(deadline.Token);
        Assert.True(await errors.MoveNextAsync(), "the start's renewal with no answer was not said");
        Assert.Equal("session.auth-failed", errors.Current.Code);
        Assert.Same(kept.Failure, errors.Current.InnerException);
        Assert.Null(session.State.Token);
        foreach (var wait in Backoff().Take(2))
        {
            await clock.WaitForAsync(wait);
            clock.Advance(wait);
            Assert.True(await errors.MoveNextAsync(), "a renewal on the backoff was not said");
            Assert.Equal("session.refresh-exhausted", errors.Current.Code);
            Assert.Same(kept.Failure, errors.Current.InnerException);
        }
        Assert.Equal(stored, await signIn.HeldAsync(deadline.Token));
    }

    // The same, for a session that started signed in: the renewal its schedule makes cannot read the sign-in, which is
    // said as session.refresh-exhausted, and the session renews again on the reconnect backoff, whose first wait is the
    // equal jitter of reconnectMs, as after any renewal with no answer.
    [Fact]
    public async Task ASignInThatCannotBeReadAtAScheduledRenewalIsARenewalWithNoAnswerAndTheBackoffGoesOn()
    {
        var clock = new TestClock();
        var signIn = Stored(clock);
        var stored = await signIn.HeldAsync();
        var kept = new SignInUnreadableAfter(signIn, reads: 1);
        using var issuer = new Issuer(timeProvider: clock, random: new ZeroRandom());
        using var session = new KeptSession(kept, (holding, cancellation) => issuer.RenewAsync(kept, holding, cancellation),
            (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), onAuthFailed: null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        await session.ReadyAsync(deadline.Token);
        var token = session.State.Token ?? throw new InvalidOperationException("The session did not start signed in");
        var due = TimeSpan.FromSeconds(Tokens.RefreshDelay(token, clock.GetUtcNow().ToUnixTimeSeconds()) ?? throw new InvalidOperationException("No schedule"));
        await clock.WaitForAsync(due);
        clock.Advance(due);
        Assert.True(await errors.MoveNextAsync(), "the scheduled renewal with no answer was not said");
        Assert.Equal("session.refresh-exhausted", errors.Current.Code);
        Assert.Same(kept.Failure, errors.Current.InnerException);
        foreach (var wait in Backoff().Take(2))
        {
            await clock.WaitForAsync(wait);
            clock.Advance(wait);
            Assert.True(await errors.MoveNextAsync(), "a renewal on the backoff was not said");
            Assert.Equal("session.refresh-exhausted", errors.Current.Code);
        }
        Assert.Equal(stored, await signIn.HeldAsync(deadline.Token));
    }

    // Every renewal is handed the token it renews (protocol/specs/src/session/cases.json): once a renewal of the token the
    // gateway refused got no answer, the renewal on the reconnect backoff is handed that token, so the kept sign-in's
    // renewal asks the issuer for another instead of giving back the token the gateway refused.
    [Fact]
    public async Task TheRenewalOnTheBackoffIsHandedTheRefusedTokenWhoseRenewalGotNoAnswer()
    {
        var clock = new TestClock();
        var kept = Stored(clock);
        var refused = (await kept.HeldAsync())?.Access ?? throw new InvalidOperationException("Nothing is stored");
        var issued = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 7200 });
        var handed = new ConcurrentQueue<string?>();
        var grants = 0;
        Task<(string Access, string? Refresh)> Grant(StoredSession read, CancellationToken cancellation) =>
            Interlocked.Increment(ref grants) == 1
                ? Task.FromException<(string, string?)>(new SignInError(ProtocolFacts.SignInError("exchange"), "The issuer did not answer"))
                : Task.FromResult<(string, string?)>((issued, "refresh-2"));
        Task<string?> Renew(string? holding, CancellationToken cancellation)
        {
            handed.Enqueue(holding);
            return KeptRenewal.RenewAsync(kept, holding, Grant, clock, cancellation);
        }
        using var session = new KeptSession(kept, Renew, (_, _) => Task.FromResult(User()), clock, new ZeroRandom(), onAuthFailed: null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        await session.ReadyAsync(deadline.Token);
        Assert.Equal(refused, session.State.Token);
        Assert.Null(await session.RefreshAsync(refused, deadline.Token));
        Assert.True(await errors.MoveNextAsync(), "the renewal with no answer was not said");
        Assert.Equal("session.refresh-exhausted", errors.Current.Code);
        var wait = Backoff().First();
        await clock.WaitForAsync(wait);
        clock.Advance(wait);
        await EventuallyAsync(() => session.State.Token is not null);
        Assert.Equal(new string?[] { refused, refused }, handed.ToArray());
        Assert.True(Volatile.Read(ref grants) == 2, "the renewal on the backoff gave a token back without asking the issuer");
        Assert.Equal(issued, session.State.Token);
        Assert.Equal(issued, (await kept.HeldAsync(deadline.Token))?.Access);
    }

    /// <summary>The reconnect backoff's waits as ZeroRandom draws them: half of each step, the step reconnectMs doubling
    /// to maxReconnectMs.</summary>
    private static IEnumerable<TimeSpan> Backoff()
    {
        var step = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("reconnectMs").GetDouble());
        var most = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("maxReconnectMs").GetDouble());
        while (true)
        {
            yield return step / 2;
            step = step * 2 < most ? step * 2 : most;
        }
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
            var handed = new ConcurrentQueue<string?>();
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
                handed.Enqueue(holding);
                var answer = issuer[Math.Min(renewals++, issuer.Length - 1)];
                if (answer == "refuses") throw new SignInError("exchange", "refused", 400);
                if (answer == "unreachable") throw new SignInError("exchange", "unreachable");
                Assert.Equal("renews", answer);
                var renewed = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600, sub = "alice", renewal = renewals });
                var found = await kept.HeldAsync(cancellation);
                if (found is null) return null;
                return await kept.RenewedAsync(found, renewed, "refresh-" + renewals, cancellation);
            }
            var ended = new ConcurrentQueue<SessionEndReason>();
            using var session = new KeptSession(kept, Renew, Validate, clock, new ZeroRandom(), ended.Enqueue);
            var errorRead = FirstSaidAsync(session.Errors());
            await session.ReadyAsync();
            running = true;
            if (part == "refusal")
            {
                var refused = row.GetProperty("refused").GetString() switch
                {
                    "held" => session.State.Token,
                    "replaced" => TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600, sub = "alice", replaced = true }),
                    var said => throw new InvalidOperationException("Unknown refused token " + said),
                };
                var given = await session.RefreshAsync(refused);
                Assert.Equal(row.GetProperty("given").GetBoolean(), given is not null);
                if (given is not null) Assert.Equal(session.State.Token, given);
            }
            Assert.Equal(row.GetProperty("asks").GetInt32(), asks);
            Assert.Equal(row.GetProperty("renewals").GetInt32(), renewals);
            static string End(KeptSession session) => session.State.Token is null ? "signed-out" : session.State.User is null ? "unconfirmed" : "signed-in";
            Assert.Equal(row.GetProperty("ends").GetString(), End(session));
            Assert.Equal(row.GetProperty("kept").GetBoolean(), await kept.HeldAsync() is not null);
            var told = row.GetProperty("told");
            SessionEndReason[] reasons = told.ValueKind == JsonValueKind.Null ? [] : [told.Deserialize<SessionEndReason>()];
            Assert.Equal(reasons, ended.ToArray());
            if (row.GetProperty("error").ValueKind != JsonValueKind.Null)
                Assert.Equal(row.GetProperty("error").GetString(), (await errorRead.WaitAsync(TimeSpan.FromSeconds(10)))?.Code);
            else Assert.False(errorRead.IsCompleted);
            if (row.TryGetProperty("then", out var next))
            {
                var pause = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("reconnectMs").GetDouble() / 2);
                await clock.WaitForAsync(pause);
                clock.Advance(pause);
                await EventuallyAsync(() => renewals == next.GetProperty("renewals").GetInt32() && asks == next.GetProperty("asks").GetInt32() && End(session) == next.GetProperty("ends").GetString());
            }
            // Each renewal is handed the token the row stored (startup), or the one its session started on (refusal).
            foreach (var token in handed)
                Assert.True(token == original.Access, part + ", " + row.GetProperty("why").GetString() + ": a renewal was handed " + (token ?? "no token"));
        }
    }

    /// <summary>The first error <paramref name="errors"/> says, or null if it ends having said none. The read is taken at
    /// once, and the stream's enumerator is the read's own, so whoever ends the stream ends the read.</summary>
    private static async Task<SemiontError?> FirstSaidAsync(IAsyncEnumerable<SemiontError> errors)
    {
        await foreach (var error in errors) return error;
        return null;
    }

    private static async Task EventuallyAsync(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition()) await Task.Delay(1, deadline.Token);
    }
}

/// <summary>A sign-in kept in memory whose keeper reads it <paramref name="reads"/> times, and fails every read after with
/// <see cref="Failure"/>.</summary>
internal sealed class SignInUnreadableAfter(MemorySignIn kept, int reads) : ISignInKept
{
    private int asked;
    internal IOException Failure { get; } = new("The kept sign-in cannot be read.");

    public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default) =>
        Interlocked.Increment(ref asked) > reads ? Task.FromException<StoredSession?>(Failure) : kept.HeldAsync(cancellation);

    public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default) => kept.KeepAsync(signIn, cancellation);
    public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default) =>
        kept.RenewedAsync(read, access, refresh, cancellation);
    public Task ForgetAsync(CancellationToken cancellation = default) => kept.ForgetAsync(cancellation);
    public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default) =>
        kept.RecordPersonKeyAsync(access, personKey, cancellation);
}
