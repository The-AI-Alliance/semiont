using System.Text.Json;
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
            var rule = row.GetProperty("rule").GetString();
            if (rule == "job") continue; // This rule belongs to the worker.
            var retries = rule switch
            {
                "boot" => ProtocolFacts.RetryEmit(status ?? throw new InvalidOperationException("Missing boot status")),
                "refresh" => ProtocolFacts.RetryRefresh(status),
                "transport" => ProtocolFacts.RetryTransport(status, method),
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
}
