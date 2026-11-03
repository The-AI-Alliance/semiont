using System.Text.Json;
using Semiont.Session;
using Xunit;

namespace Semiont.Tests;

public sealed class TokenTests
{
    [Fact]
    public void EveryTokenExpiryCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/session/cases.json")));
        foreach (var row in table.RootElement.GetProperty("tokenExpiry").EnumerateArray())
        {
            var expected = row.GetProperty("exp");
            Assert.Equal(expected.ValueKind == JsonValueKind.Null ? null : (double?)expected.GetDouble(), Tokens.TokenExpiry(row.GetProperty("token").GetString() ?? throw new InvalidOperationException("No token")));
        }
    }

    [Fact]
    public void EveryRefreshScheduleCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/session/cases.json")));
        foreach (var row in table.RootElement.GetProperty("refreshSchedule").EnumerateArray())
        {
            var token = row.TryGetProperty("token", out var stated) ? stated.GetString() : Jwt(row.GetProperty("claims"));
            var delay = row.GetProperty("delay");
            Assert.Equal(delay.ValueKind == JsonValueKind.Null ? null : (double?)delay.GetDouble(), Tokens.RefreshDelay(token ?? throw new InvalidOperationException("No token"), row.GetProperty("now").GetDouble()));
        }
    }

    internal static string Jwt<T>(T claims) => "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(claims)).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2lnbmF0dXJl";
}
