using System.Text.Json;

namespace Semiont.Protocol;

internal static class ProtocolFacts
{
    private static readonly JsonDocument Registry = JsonDocument.Parse(ProtocolTables.Registry);
    private static readonly JsonDocument Timings = JsonDocument.Parse(ProtocolTables.Timing);
    private static readonly JsonDocument Errors = JsonDocument.Parse(ProtocolTables.Errors);
    private static readonly JsonDocument Retry = JsonDocument.Parse(ProtocolTables.Retry);

    internal static JsonElement Timing(string name) => Timings.RootElement.GetProperty("timing").EnumerateArray()
        .Single(row => row.GetProperty("name").GetString() == name).GetProperty("value");

    internal static string[] Channels(string audience) => Registry.RootElement.GetProperty("audience").GetProperty(audience)
        .EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("A channel is null")).ToArray();

    internal static string TraceField => Registry.RootElement.GetProperty("trace").GetProperty("field").GetString()
        ?? throw new InvalidOperationException("No trace field");

    internal static IEnumerable<(string Request, string Result, string Failure)> Operations() =>
        Registry.RootElement.GetProperty("operations").EnumerateArray().Select(operation => (
            operation.GetProperty("request").GetString() ?? throw new InvalidOperationException("Missing request channel"),
            operation.GetProperty("result").GetString() ?? throw new InvalidOperationException("Missing result channel"),
            operation.GetProperty("failure").GetString() ?? throw new InvalidOperationException("Missing failure channel")));

    internal static (string Result, string Failure) Operation(string channel)
    {
        var (_, result, failure) = Operations().Single(operation => operation.Request == channel);
        return (result, failure);
    }

    /// <summary>The component schema a payload on <paramref name="channel"/> is.</summary>
    internal static string PayloadSchema(string channel)
    {
        var row = Registry.RootElement.GetProperty("channels").EnumerateArray()
            .Single(row => row.GetProperty("channel").GetString() == channel);
        if (row.GetProperty("shape").GetString() != "schema")
            throw new InvalidOperationException($"A payload on {channel} is no component schema.");
        return row.GetProperty("schema").GetString() ?? throw new InvalidOperationException($"{channel} names a null schema.");
    }

    internal static IEnumerable<string> EventChannels() => Registry.RootElement.GetProperty("channels").EnumerateArray()
        .Where(row => row.TryGetProperty("event", out _))
        .Select(row => row.GetProperty("channel").GetString() ?? throw new InvalidOperationException("A channel is null"));

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

    private static bool RetryStatus(string rule, int? status) => Retry.RootElement.GetProperty("rules").EnumerateArray().Any(row =>
        row.GetProperty("rule").GetString() == rule && row.GetProperty("retries").GetBoolean() &&
        (row.TryGetProperty("status", out var stated) ? stated.GetInt32() == status : status is null));

    internal static bool RetryEmit(int status) => RetryStatus("boot", status);

    internal static bool RetryTransport(int? status, string? method, bool keyed) =>
        status is not null && (keyed || method?.ToUpperInvariant() is ("GET" or "HEAD" or "PUT" or "DELETE" or "OPTIONS" or "TRACE")) &&
        RetryStatus("transport", status);

    internal static string SignInError(string name) => Errors.RootElement.GetProperty("signIn").GetProperty("codes").EnumerateArray()
        .Select(row => row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code"))
        .Single(code => code == name);

    internal static string SessionError(string name) => Errors.RootElement.GetProperty("session").GetProperty("codes").EnumerateArray()
        .Select(row => row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code"))
        .Single(code => code == "session." + name);

    internal static string JobError(string name) => Errors.RootElement.GetProperty("job").GetProperty("codes").EnumerateArray()
        .Select(row => row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code"))
        .Single(code => code == "job." + name);

    internal static string SpanRefusal(string code) => Errors.RootElement.GetProperty("spanRefusal").GetProperty("codes").EnumerateArray()
        .Select(row => row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null error code"))
        .Single(declared => declared == code);

    internal static bool RetryRefresh(int? status) => RetryStatus("refresh", status >= 500 ? 500 : status);

    internal static long? RetryAfterMilliseconds(string? header)
    {
        var seconds = header.AsSpan().Trim();
        if (seconds.IsEmpty || seconds.ContainsAnyExceptInRange('0', '9')) return null;
        return long.TryParse(seconds, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value)
            && value <= long.MaxValue / 1000 ? value * 1000 : null;
    }
}
