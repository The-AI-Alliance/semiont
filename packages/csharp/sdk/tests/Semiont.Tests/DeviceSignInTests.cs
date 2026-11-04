using System.Net;
using System.Text.Json;
using Semiont.SignIn;
using Semiont.Types;
using Semiont.Errors;
using Semiont.Protocol;
using Xunit;

namespace Semiont.Tests;

public sealed class DeviceSignInTests
{
    private static HttpEndpoint Endpoint() => JsonSerializer.Deserialize<HttpEndpoint>("{\"kind\":\"http\",\"host\":\"kb.example\",\"port\":443,\"protocol\":\"https\"}") ?? throw new InvalidOperationException("No endpoint");

    [Fact]
    public async Task DeviceSignInDiscoversTheIssuerWaitsForApprovalAndKeepsItsRefreshToken()
    {
        var clock = new TestClock();
        var token = TokenTests.Jwt(new { iss = "https://issuer.example", exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 });
        using var handler = new Handler(token);
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var kept = new MemorySignIn();
        DeviceCode? code = null;
        var signing = issuer.SignInDeviceAsync(Endpoint(), kept, value => code = value);
        await clock.WaitForAsync(TimeSpan.FromSeconds(5));
        Assert.NotNull(code);
        Assert.Equal("ABCD", code.UserCode);
        Assert.Equal("https://issuer.example/verify", code.VerificationUri);
        Assert.DoesNotContain("secret-code", code.ToString(), StringComparison.Ordinal);
        Assert.Equal(0, handler.Polls);
        Assert.Null(await kept.HeldAsync());
        clock.Advance(TimeSpan.FromSeconds(5));
        await clock.WaitForAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, handler.Polls);
        clock.Advance(TimeSpan.FromSeconds(5));
        await signing.WaitAsync(TimeSpan.FromSeconds(10));
        var held = await kept.HeldAsync();
        Assert.NotNull(held);
        Assert.Equal(token, held.Access);
        Assert.Equal("refresh", held.Refresh);
        Assert.Equal("https://issuer.example/token", held.TokenEndpoint);
        Assert.Equal("https://issuer.example/revoke", held.RevocationEndpoint);
        Assert.Equal(SignInPolicy.ScriptClientId, held.ClientId);
        await issuer.SignOutAsync(kept);
        Assert.Null(await kept.HeldAsync());
        Assert.Equal(1, handler.Revocations);
    }

    [Theory]
    [InlineData("access_denied", "denied")]
    [InlineData("expired_token", "expired")]
    [InlineData("invalid_grant", "exchange")]
    public async Task TerminalDeviceAnswersDoNotKeepCredentials(string answer, string expected)
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        handler.PollAnswers.Enqueue((400, JsonSerializer.Serialize(new { error = answer })));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var kept = new MemorySignIn();
        var signing = issuer.SignInDeviceAsync(Endpoint(), kept, _ => { });
        await clock.WaitForAsync(TimeSpan.FromSeconds(5));
        clock.Advance(TimeSpan.FromSeconds(5));
        var error = await Assert.ThrowsAsync<SignInError>(() => signing);
        Assert.Equal(expected, error.Code);
        Assert.Null(await kept.HeldAsync());
        Assert.Equal(1, handler.Polls);
    }

    [Fact]
    public async Task SlowDownIncreasesEverySubsequentWait()
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        handler.PollAnswers.Enqueue((400, "{\"error\":\"slow_down\"}"));
        handler.PollAnswers.Enqueue((400, "{\"error\":\"authorization_pending\"}"));
        handler.PollAnswers.Enqueue((200, "{\"access_token\":\"token\",\"refresh_token\":\"refresh\"}"));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var signing = issuer.SignInDeviceAsync(Endpoint(), new MemorySignIn(), _ => { });
        var interval = TimeSpan.FromSeconds(5);
        await clock.WaitForAsync(interval);
        clock.Advance(interval);
        interval += TimeSpan.FromMilliseconds(ProtocolFacts.Timing("deviceSlowDownMs").GetDouble());
        await clock.WaitForAsync(interval);
        Assert.Equal(1, handler.Polls);
        clock.Advance(interval);
        await clock.WaitForAsync(interval);
        Assert.Equal(2, handler.Polls);
        clock.Advance(interval);
        await signing.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(3, handler.Polls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0d)]
    [InlineData(0.1d)]
    public async Task AbsentAndTinyIntervalsUseTheOwnedPollingPolicy(double? interval)
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        var device = new Dictionary<string, object>
        { ["device_code"] = "secret-code", ["user_code"] = "ABCD", ["verification_uri"] = "https://issuer.example/verify", ["expires_in"] = 60 };
        if (interval is double value) device["interval"] = value;
        handler.Answers["/device"] = (200, JsonSerializer.Serialize(device));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        using var cancellation = new CancellationTokenSource();
        var signing = issuer.SignInDeviceAsync(Endpoint(), new MemorySignIn(), _ => { }, cancellation.Token);
        var wait = interval is null ? ProtocolFacts.Timing("devicePollMs").GetDouble() : ProtocolFacts.Timing("devicePollFloorMs").GetDouble();
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(wait));
        Assert.Equal(0, handler.Polls);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => signing);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task ALocalDeadlineExpiresWithoutPollingAfterIt(int seconds)
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        handler.Answers["/device"] = (200, JsonSerializer.Serialize(new { device_code = "secret-code", user_code = "ABCD", verification_uri = "https://issuer.example/verify", expires_in = seconds, interval = 5 }));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var signing = issuer.SignInDeviceAsync(Endpoint(), new MemorySignIn(), _ => { });
        if (seconds > 0)
        {
            await clock.WaitForAsync(TimeSpan.FromSeconds(seconds));
            clock.Advance(TimeSpan.FromSeconds(seconds));
        }
        var error = await Assert.ThrowsAsync<SignInError>(() => signing);
        Assert.Equal("expired", error.Code);
        Assert.Equal(0, handler.Polls);
    }

    [Theory]
    [InlineData("/.well-known/oauth-protected-resource", 404, "", "no-issuer")]
    [InlineData("/.well-known/oauth-protected-resource", 200, "{}", "discovery")]
    [InlineData("/.well-known/oauth-protected-resource", 200, "{\"resource\":\"https://kb.example\",\"authorization_servers\":[\"not-a-url\"],\"bearer_methods_supported\":[\"header\"]}", "discovery")]
    [InlineData("/.well-known/oauth-protected-resource", 200, "{\"resource\":\"https://kb.example\",\"authorization_servers\":[],\"bearer_methods_supported\":[\"header\"]}", "no-issuer")]
    [InlineData("/.well-known/openid-configuration", 200, "{\"issuer\":\"https://other.example\",\"authorization_endpoint\":\"https://issuer.example/authorize\",\"token_endpoint\":\"https://issuer.example/token\",\"device_authorization_endpoint\":\"https://issuer.example/device\"}", "discovery")]
    [InlineData("/.well-known/openid-configuration", 503, "unavailable", "discovery")]
    [InlineData("/.well-known/openid-configuration", 200, "{\"issuer\":\"https://issuer.example\",\"authorization_endpoint\":\"https://issuer.example/authorize\",\"token_endpoint\":\"https://issuer.example/token\"}", "discovery")]
    [InlineData("/device", 200, "{}", "exchange")]
    [InlineData("/device", 200, "{\"device_code\":\"secret-code\",\"user_code\":\"ABCD\",\"verification_uri\":\"https://issuer.example/verify\"}", "exchange")]
    public async Task InvalidDiscoveryAndAuthorizationAnswersAreRefused(string path, int status, string body, string expected)
    {
        using var handler = new Handler("token");
        handler.Answers[path] = (status, body);
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client);
        var error = await Assert.ThrowsAsync<SignInError>(() => issuer.SignInDeviceAsync(Endpoint(), new MemorySignIn(), _ => throw new InvalidOperationException("No code should be shown")));
        Assert.Equal(expected, error.Code);
        Assert.Equal(0, handler.Polls);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"access_token\":\"token\"}")]
    [InlineData("{\"access_token\":\"token\",\"refresh_token\":null}")]
    public async Task ApprovalWithoutUsableTokensKeepsNothing(string body)
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        handler.PollAnswers.Enqueue((200, body));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var kept = new MemorySignIn();
        var signing = issuer.SignInDeviceAsync(Endpoint(), kept, _ => { });
        await clock.WaitForAsync(TimeSpan.FromSeconds(5));
        clock.Advance(TimeSpan.FromSeconds(5));
        var error = await Assert.ThrowsAsync<SignInError>(() => signing);
        Assert.Equal("exchange", error.Code);
        Assert.Null(await kept.HeldAsync());
    }

    [Fact]
    public async Task DisposingTheIssuerEndsDevicePolling()
    {
        var clock = new TestClock();
        using var handler = new Handler("token");
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var kept = new MemorySignIn();
        var signing = issuer.SignInDeviceAsync(Endpoint(), kept, _ => { });
        await clock.WaitForAsync(TimeSpan.FromSeconds(5));
        issuer.Dispose();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => signing);
        Assert.Null(await kept.HeldAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SignOutStillForgetsCredentialsWhenRevocationCannotBeDelivered(bool network)
    {
        using var handler = new Handler("token");
        handler.Answers["/revoke"] = (503, "unavailable");
        handler.FailRevocation = network;
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client);
        var kept = new MemorySignIn(new StoredSession
        {
            Access = "token",
            Refresh = "refresh",
            ClientId = SignInPolicy.ScriptClientId,
            TokenEndpoint = "https://issuer.example/token",
            RevocationEndpoint = "https://issuer.example/revoke",
        });
        await issuer.SignOutAsync(kept);
        Assert.Null(await kept.HeldAsync());
    }

    [Fact]
    public async Task AFailedCredentialWriteRaisesTheStoresOwnFailure()
    {
        var clock = new TestClock();
        var token = TokenTests.Jwt(new { iss = "https://issuer.example", exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 });
        using var handler = new Handler(token);
        handler.PollAnswers.Enqueue((200, JsonSerializer.Serialize(new { access_token = token, refresh_token = "refresh" })));
        using var client = new HttpClient(handler);
        using var issuer = new Issuer(client, clock);
        var directory = Path.Combine(Path.GetTempPath(), "semiont-device-" + Guid.NewGuid());
        var store = new SignInStore(directory, clock);
        Directory.CreateDirectory(store.FilePath);
        try
        {
            var signing = issuer.SignInDeviceAsync(Endpoint(), store.Entry("stack"), _ => { });
            await clock.WaitForAsync(TimeSpan.FromSeconds(5));
            clock.Advance(TimeSpan.FromSeconds(5));
            var error = await Record.ExceptionAsync(() => signing);
            Assert.True(error is IOException or UnauthorizedAccessException);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private sealed class Handler(string token) : HttpMessageHandler
    {
        internal int Polls { get; private set; }
        internal int Revocations { get; private set; }
        internal Dictionary<string, (int Status, string Body)> Answers { get; } = [];
        internal Queue<(int Status, string Body)> PollAnswers { get; } = [];
        internal bool FailRevocation { get; set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri ?? throw new InvalidOperationException("No URI");
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            if (FailRevocation && uri.AbsolutePath == "/revoke") throw new HttpRequestException("unreachable");
            if (Answers.TryGetValue(uri.AbsolutePath, out var scripted)) return new HttpResponseMessage((HttpStatusCode)scripted.Status) { Content = new StringContent(scripted.Body) };
            var (status, answer) = uri.AbsolutePath switch
            {
                "/.well-known/oauth-protected-resource" => (200, "{\"resource\":\"https://kb.example\",\"authorization_servers\":[\"https://issuer.example\"],\"bearer_methods_supported\":[\"header\"]}"),
                "/.well-known/openid-configuration" => (200, "{\"issuer\":\"https://issuer.example\",\"authorization_endpoint\":\"https://issuer.example/authorize\",\"token_endpoint\":\"https://issuer.example/token\",\"device_authorization_endpoint\":\"https://issuer.example/device\",\"revocation_endpoint\":\"https://issuer.example/revoke\"}"),
                "/device" => Device(body),
                "/token" => Poll(body),
                "/revoke" => Revoke(body),
                _ => throw new InvalidOperationException("Unexpected request: " + uri),
            };
            return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(answer) };
        }
        private static (int, string) Device(string? body)
        {
            Assert.Contains("client_id=" + SignInPolicy.ScriptClientId, body, StringComparison.Ordinal);
            Assert.Contains("scope=" + Uri.EscapeDataString(SignInPolicy.Scope).Replace("%20", "+", StringComparison.Ordinal), body, StringComparison.Ordinal);
            return (200, "{\"device_code\":\"secret-code\",\"user_code\":\"ABCD\",\"verification_uri\":\"https://issuer.example/verify\",\"expires_in\":60,\"interval\":5}");
        }
        private (int, string) Poll(string? body)
        {
            Assert.Contains("device_code=secret-code", body, StringComparison.Ordinal);
            Polls++;
            return PollAnswers.Count > 0 ? PollAnswers.Dequeue() : Polls == 1 ? (400, "{\"error\":\"authorization_pending\"}") : (200, JsonSerializer.Serialize(new { access_token = token, refresh_token = "refresh" }));
        }
        private (int, string) Revoke(string? body)
        {
            Assert.Contains("token=refresh", body, StringComparison.Ordinal);
            Revocations++;
            return (200, "");
        }
    }
}
