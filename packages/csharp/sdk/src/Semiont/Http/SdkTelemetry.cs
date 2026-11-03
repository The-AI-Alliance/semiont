using Semiont.Protocol;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using Semiont.Identifiers;

namespace Semiont.Http;

internal static class SdkTelemetry
{
    private static readonly JsonDocument Table = JsonDocument.Parse(ProtocolTables.Telemetry);
    private static readonly ActivitySource Activities = new("semiont");
    private static readonly Meter Meter = new("semiont");
    private static readonly Dictionary<string, Counter<long>> Counters = Table.RootElement.GetProperty("metrics").EnumerateArray().ToDictionary(
        row => row.GetProperty("name").GetString() ?? throw new InvalidOperationException("Null metric name"),
        row => row.GetProperty("instrument").GetString() == "counter"
            ? Meter.CreateCounter<long>(row.GetProperty("name").GetString() ?? throw new InvalidOperationException("Null metric name"))
            : throw new InvalidOperationException("Unsupported metric instrument"));

    internal static Activity? Start(string name, ActivityTagsCollection attributes, string? channel = null, ActivityContext parent = default)
    {
        var row = Table.RootElement.GetProperty("spans").EnumerateArray().Single(row => row.GetProperty("name").GetString() == name);
        Validate(row, attributes);
        var kind = Enum.Parse<ActivityKind>(row.GetProperty("kind").GetString() ?? throw new InvalidOperationException("Null span kind"), ignoreCase: true);
        return Activities.StartActivity(name.Replace("{channel}", channel ?? "", StringComparison.Ordinal), kind, parent, attributes);
    }

    internal static ActivityTagsCollection BusTags(string channel, ResourceId? scope)
    {
        var tags = new ActivityTagsCollection { { "bus.channel", channel } };
        if (scope is ResourceId resource) tags.Add("bus.scope", resource.Value);
        return tags;
    }

    internal static void Sent(string channel, ResourceId? scope)
    {
        const string name = "semiont.bus.sent";
        var tags = BusTags(channel, scope);
        Validate(Table.RootElement.GetProperty("metrics").EnumerateArray().Single(row => row.GetProperty("name").GetString() == name), tags);
        Counters[name].Add(1, tags.ToArray());
    }

    private static void Validate(JsonElement row, ActivityTagsCollection attributes)
    {
        var stated = row.GetProperty("attributes").EnumerateArray().ToDictionary(attribute => attribute.GetProperty("key").GetString() ?? throw new InvalidOperationException("Null attribute name"));
        foreach (var attribute in attributes)
        {
            if (!stated.ContainsKey(attribute.Key)) throw new InvalidOperationException("Unstated telemetry attribute " + attribute.Key);
        }
        foreach (var attribute in stated)
        {
            if (!attribute.Value.TryGetProperty("only", out _) && !attributes.Any(tag => tag.Key == attribute.Key)) throw new InvalidOperationException("Missing telemetry attribute " + attribute.Key);
        }
    }
}
