using System.Text.Json;
using System.Text.Json.Nodes;

namespace Semiont.Http;

internal static class BusLog
{
    private static readonly JsonDocument Table = JsonDocument.Parse(TransportTables.Log);
    private static readonly HashSet<string> Names = Table.RootElement.GetProperty("names").EnumerateArray()
        .Select(name => name.GetString() ?? throw new InvalidOperationException("Null withheld name")).ToHashSet(StringComparer.Ordinal);

    internal static JsonNode? Shown(JsonNode? payload)
    {
        if (payload is JsonObject obj)
        {
            var shown = new JsonObject();
            foreach (var member in obj) shown.Add(member.Key, Names.Contains(member.Key) ? JsonValue.Create("[withheld]") : Shown(member.Value));
            return shown;
        }
        if (payload is JsonArray array) return new JsonArray(array.Select(Shown).ToArray());
        return payload?.DeepClone();
    }

    internal static void Line(string direction, string channel, JsonElement payload)
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SEMIONT_BUS_LOG")))
            Console.Error.WriteLine($"{direction} {channel} {JsonSerializer.Serialize(Shown(JsonNode.Parse(payload.GetRawText())))}");
    }
}
