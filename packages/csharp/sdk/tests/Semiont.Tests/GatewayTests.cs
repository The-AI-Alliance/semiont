using System.Net;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Session;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed class GatewayTests
{
    [Fact]
    public void EveryGatewayOriginCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/session/gateway-url-cases.json")));
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var endpoint = row.GetProperty("endpoint").Deserialize<HttpEndpoint>() ?? throw new InvalidOperationException("No endpoint");
            if (row.GetProperty("origin").ValueKind == JsonValueKind.Null) Assert.Throws<SignInError>(() => Gateway.Origin(endpoint));
            else Assert.Equal(row.GetProperty("origin").GetString(), Gateway.Origin(endpoint));
        }
    }

    [Theory]
    [InlineData(401)]
    [InlineData(429)]
    [InlineData(503)]
    public async Task AskingWhoATokenIsMakesExactlyOneRequestAndOpensNoStream(int status)
    {
        using var handler = new Handler(status);
        using var client = new HttpClient(handler);
        await Assert.ThrowsAsync<TransportError>(() => Gateway.GetCurrentUserAsync("https://gateway.example", "token", client));
        Assert.Equal(1, handler.Calls);
    }

    private sealed class Handler(int status) : HttpMessageHandler
    {
        internal int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal("/api/users/me", request.RequestUri?.AbsolutePath);
            Assert.Equal("token", request.Headers.Authorization?.Parameter);
            return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("{}") });
        }
    }
}
