using System.Text.Json;

namespace Semiont.Http;

internal static class TransportFacts
{
    private static readonly JsonDocument Registry = JsonDocument.Parse(TransportTables.Registry);
    private static readonly JsonDocument Timings = JsonDocument.Parse(TransportTables.Timing);
    private static readonly JsonDocument Errors = JsonDocument.Parse(TransportTables.Errors);
    private static readonly JsonDocument Retry = JsonDocument.Parse(TransportTables.Retry);

    internal static JsonElement Timing(string name) => Timings.RootElement.GetProperty("timing").EnumerateArray()
        .Single(row => row.GetProperty("name").GetString() == name).GetProperty("value");

    internal static string[] Channels(string audience) => Registry.RootElement.GetProperty("audience").GetProperty(audience)
        .EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("A channel is null")).ToArray();

    internal static string TraceField => Registry.RootElement.GetProperty("trace").GetProperty("field").GetString()
        ?? throw new InvalidOperationException("No trace field");

    internal static (string Result, string Failure) Operation(string channel)
    {
        var row = Registry.RootElement.GetProperty("operations").EnumerateArray().Single(operation => operation.GetProperty("request").GetString() == channel);
        return (row.GetProperty("result").GetString() ?? throw new InvalidOperationException("No result channel"),
            row.GetProperty("failure").GetString() ?? throw new InvalidOperationException("No failure channel"));
    }

    internal static string Failure(string? wire)
    {
        var family = Errors.RootElement.GetProperty("busRequest");
        foreach (var code in family.GetProperty("codes").EnumerateArray())
        {
            if (code.TryGetProperty("wire", out var named) && named.GetString() == wire)
            {
                return code.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code");
            }
        }
        return family.GetProperty("unrecognizedFailure").GetString() ?? throw new InvalidOperationException("No unrecognized failure code");
    }

    internal static string BusError(string name) => Errors.RootElement.GetProperty("busRequest").GetProperty("codes").EnumerateArray()
        .Select(row => row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code"))
        .Single(code => code == "bus." + name);

    internal static string Error(int status)
    {
        var family = Errors.RootElement.GetProperty("transport");
        foreach (var row in family.GetProperty("codes").EnumerateArray())
        {
            if (row.TryGetProperty("status", out var exact) && exact.GetInt32() == status ||
                row.TryGetProperty("statusFrom", out var minimum) && status >= minimum.GetInt32())
            {
                return row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code");
            }
        }
        return family.GetProperty("unclassified").GetString() ?? throw new InvalidOperationException("No unclassified error code");
    }

    internal static bool RetryEmit(int status) => Retry.RootElement.GetProperty("rules").EnumerateArray().Any(row =>
        row.GetProperty("rule").GetString() == "boot" && row.TryGetProperty("status", out var stated) && stated.GetInt32() == status && row.GetProperty("retries").GetBoolean());
}
