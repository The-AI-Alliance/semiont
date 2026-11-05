using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Semiont.SignIn;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed class ServiceTokenTests
{
    private static JsonDocument Cases() => JsonDocument.Parse(File.ReadAllText(
        Path.Join(AppContext.BaseDirectory, "specs/session/client-assertion-cases.json")));

    [Fact]
    public void EverySharedAssertionCaseRuns()
    {
        using var table = Cases();
        foreach (var row in table.RootElement.GetProperty("thumbprints").EnumerateArray())
            Assert.Equal(Text(row, "thumbprint"), ClientAssertion.Thumbprint(Text(row.GetProperty("jwk"), "n"), Text(row.GetProperty("jwk"), "e")));
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var jwk = row.GetProperty("jwk");
            using var header = JsonDocument.Parse(ClientAssertion.Header(Text(jwk, "n"), Text(jwk, "e")));
            using var claims = JsonDocument.Parse(ClientAssertion.Claims(Text(row, "clientId"), Text(row, "tokenEndpoint"),
                row.GetProperty("issuedAt").GetInt64(), Text(row, "jti")));
            Assert.True(JsonElement.DeepEquals(row.GetProperty("header"), header.RootElement));
            Assert.True(JsonElement.DeepEquals(row.GetProperty("claims"), claims.RootElement));
        }
    }

    [Fact]
    public async Task KeyGrantsSignFreshAssertionsAndDiscoverOnce()
    {
        using var key = RSA.Create(2048);
        using var table = Cases();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var clock = new TestClock();
        using var handler = new Handler(async (request, cancellation) =>
        {
            var form = await ReadFormAsync(request, cancellation);
            var policy = table.RootElement;
            Assert.Equal(policy.GetProperty("form").EnumerateArray().Select(item => item.GetString()).Order(), form.Keys.Order());
            Assert.Equal(Text(policy, "grantType"), form["grant_type"]);
            Assert.Equal(Text(policy, "assertionType"), form["client_assertion_type"]);
            var pieces = form["client_assertion"].Split('.');
            Assert.Equal(3, pieces.Length);
            Assert.True(key.VerifyData(Encoding.ASCII.GetBytes(pieces[0] + "." + pieces[1]), Base64Url.DecodeFromChars(pieces[2]),
                HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
            using var claims = JsonDocument.Parse(Base64Url.DecodeFromChars(pieces[1]));
            var body = claims.RootElement;
            Assert.Equal("worker", Text(body, "sub"));
            Assert.Equal("worker", Text(body, "iss"));
            Assert.Equal("https://issuer.example/token", Text(body, "aud"));
            Assert.Equal(clock.GetUtcNow().ToUnixTimeSeconds(), body.GetProperty("iat").GetInt64());
            Assert.True(seen.Add(Text(body, "jti")));
            return Reply(new { access_token = "token-" + seen.Count, expires_in = 60 });
        });
        using var client = new HttpClient(handler);
        using var service = new ServiceToken("https://issuer.example", "worker", key, client, clock);
        Assert.Equal("Bearer token-1", await service.AuthorizationAsync());
        Assert.Equal("Bearer token-1", await service.AuthorizationAsync());
        clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal("Bearer token-2", await service.AuthorizationAsync());
        Assert.Equal(1, handler.Discoveries);
    }

    [Fact]
    public async Task ConcurrentServiceCallersShareTheGrantWhenOneStopsWaiting()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler(async (request, cancellation) =>
        {
            var form = await ReadFormAsync(request, cancellation);
            Assert.Equal("worker", form["client_id"]);
            Assert.Equal("secret &+", form["client_secret"]);
            entered.TrySetResult();
            await release.Task.WaitAsync(cancellation);
            return Reply(new { access_token = "shared", expires_in = 60 });
        });
        using var client = new HttpClient(handler);
        using var service = new ServiceToken("https://issuer.example", "worker", "secret &+", client);
        using var cancellation = new CancellationTokenSource();
        var abandoned = service.AuthorizationAsync(cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var waiting = service.AuthorizationAsync();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
        release.SetResult();
        Assert.Equal("Bearer shared", await waiting.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(1, handler.Grants);
    }

    [Fact]
    public async Task AgentValidatesOnceAndRenewsOnScheduleAndRefusal()
    {
        var clock = new TestClock();
        var sequence = 0;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler(async (_, cancellation) =>
        {
            if (sequence == 2)
            {
                entered.TrySetResult();
                await release.Task.WaitAsync(cancellation);
            }
            var now = clock.GetUtcNow().ToUnixTimeSeconds();
            var access = TokenTests.Jwt(new { iat = now, exp = now + 60, sequence = ++sequence });
            return Reply(new { access_token = access, expires_in = 60 });
        });
        using var client = new HttpClient(handler);
        using var service = new ServiceToken("https://issuer.example", "worker", "secret", client, clock);
        var endpoint = JsonSerializer.Deserialize<HttpEndpoint>("""{"kind":"http","host":"kb.example","port":443,"protocol":"https"}""")
            ?? throw new InvalidOperationException("Missing endpoint");
        using var agent = new AgentToken(endpoint, service, client, clock);
        await agent.SignInAsync();
        Assert.NotNull(agent.Did);
        Assert.Equal(1, handler.Identities);
        var first = agent.Token;
        await using var observer = agent.TokensChanged().GetAsyncEnumerator();
        Assert.True(await observer.MoveNextAsync());
        Assert.Equal(first, observer.Current);
        await clock.WaitForAsync(TimeSpan.FromSeconds(30));
        clock.Advance(TimeSpan.FromSeconds(30));
        Assert.True(await observer.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10)));
        var renewed = observer.Current;
        Assert.NotEqual(first, renewed);
        Assert.Equal(renewed, await agent.RefreshAsync(first));
        using var cancellation = new CancellationTokenSource();
        var abandoned = agent.RefreshAsync(renewed, cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var waiting = agent.RefreshAsync(renewed);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
        release.SetResult();
        Assert.NotEqual(renewed, await waiting.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(3, handler.Grants);
        Assert.Equal(1, handler.Identities);
        agent.Dispose();
        Assert.True(await observer.MoveNextAsync());
        Assert.False(await observer.MoveNextAsync());
    }

    private static string Text(JsonElement row, string key) => row.GetProperty(key).GetString() ?? throw new InvalidOperationException(key);

    private static async Task<Dictionary<string, string>> ReadFormAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        var content = request.Content ?? throw new InvalidOperationException("Missing form");
        var text = await content.ReadAsStringAsync(cancellation);
        return text.Split('&').Select(pair => pair.Split('=', 2))
            .ToDictionary(pair => WebUtility.UrlDecode(pair[0]), pair => WebUtility.UrlDecode(pair[1]), StringComparer.Ordinal);
    }

    private static HttpResponseMessage Reply<T>(T body) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body)) };

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> grant) : HttpMessageHandler
    {
        internal int Discoveries { get; private set; }
        internal int Grants { get; private set; }
        internal int Identities { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            switch (request.RequestUri?.AbsolutePath)
            {
                case "/.well-known/openid-configuration":
                    Discoveries++;
                    return Task.FromResult(Reply(new
                    {
                        issuer = "https://issuer.example",
                        authorization_endpoint = "https://issuer.example/authorize",
                        token_endpoint = "https://issuer.example/token",
                    }));
                case "/token":
                    Grants++;
                    Assert.Equal(HttpMethod.Post, request.Method);
                    return grant(request, cancellationToken);
                case "/api/users/me":
                    Identities++;
                    Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
                    return Task.FromResult(Reply(new { did = "did:web:kb.example:agents:worker", domain = "kb.example", email = (string?)null, name = (string?)null, image = (string?)null }));
                default:
                    throw new InvalidOperationException("Unexpected request");
            }
        }
    }
}
