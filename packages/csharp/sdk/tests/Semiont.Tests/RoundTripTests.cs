using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Semiont.Tests;

public sealed class RoundTripTests
{
    [Fact]
    public void EveryResolvedCorpusPayloadRoundTrips()
    {
        var root = AppContext.BaseDirectory;
        using var registry = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "specs/bus/registry.json")));
        var channels = registry.RootElement.GetProperty("channels").EnumerateArray()
            .Where(channel => channel.GetProperty("shape").GetString() is "schema" or "storedEvent" or "envelope")
            .ToDictionary(channel => channel.GetProperty("channel").GetString() ?? throw new InvalidOperationException("Unnamed channel"), channel => channel.Clone());
        var failures = new List<string>();
        var held = 0;
        var refused = 0;
        foreach (var corpus in new[] { "sdk/wire", "sdk/live", "worker" })
        {
            foreach (var file in Directory.GetFiles(Path.Combine(root, "corpus", corpus), "*.json", SearchOption.AllDirectories))
            {
                var names = new Dictionary<string, JsonNode?>();
                foreach (var name in new[] { "r1", "r2", "r3", "a1", "a2" })
                {
                    names.Add(name, JsonValue.Create(name));
                }
                foreach (var name in new[] { "client", "participant" })
                {
                    names.Add(name, JsonValue.Create("did:web:example.org:users:" + name));
                }
                foreach (var frame in Frames(JsonNode.Parse(File.ReadAllText(file)), names))
                {
                    if (!channels.TryGetValue(frame.Channel, out var channel) || frame.Payload is null)
                    {
                        continue;
                    }
                    var shape = channel.GetProperty("shape").GetString();
                    var payload = shape == "envelope" ? frame.Payload["response"] : frame.Payload;
                    if (payload is null)
                    {
                        continue;
                    }
                    var schema = channel.GetProperty(shape == "storedEvent" ? "payload" : "schema").GetString();
                    var type = Assembly.Load("Semiont").GetType("Semiont.Types." + schema);
                    Assert.NotNull(type);
                    var expectedRefusal = Path.GetFileName(file) == "failure-codes.json" && payload["code"]?.ToString() == "not-invented-yet" ||
                        Path.GetFileName(file) == "malformed-reply.json" && JsonNode.DeepEquals(payload, JsonNode.Parse("{\"response\":{\"status\":\"running\",\"params\":{\"resourceId\":\"r1\"}}}"));
                    try
                    {
                        var value = JsonSerializer.Deserialize(payload, type);
                        var back = JsonSerializer.SerializeToNode(value, type);
                        if (expectedRefusal)
                        {
                            failures.Add(Path.GetFileName(file) + ": malformed payload accepted");
                            continue;
                        }
                        held++;
                        RemoveMissingStamps(payload, back);
                        if (!JsonNode.DeepEquals(payload, back))
                        {
                            failures.Add(Path.GetFileName(file) + " " + schema + ": " + payload + " became " + back);
                        }
                    }
                    catch (JsonException error)
                    {
                        if (expectedRefusal)
                        {
                            refused++;
                        }
                        else
                        {
                            failures.Add(Path.GetFileName(file) + " " + schema + ": " + error.Message);
                        }
                    }
                }
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
        Assert.Equal(2, refused);
        Assert.True(held >= 150, "Only " + held + " corpus payloads were checked");
    }

    private static void RemoveMissingStamps(JsonNode read, JsonNode? written)
    {
        if (read is JsonObject source && written is JsonObject target)
        {
            foreach (var pair in source.ToArray())
            {
                if (!target.ContainsKey(pair.Key) && pair.Key.StartsWith('_'))
                {
                    source.Remove(pair.Key);
                }
                else if (pair.Value is JsonNode value)
                {
                    RemoveMissingStamps(value, target[pair.Key]);
                }
            }
        }
        else if (read is JsonArray sourceArray && written is JsonArray targetArray && sourceArray.Count == targetArray.Count)
        {
            for (var index = 0; index < sourceArray.Count; index++)
            {
                if (sourceArray[index] is JsonNode value)
                {
                    RemoveMissingStamps(value, targetArray[index]);
                }
            }
        }
    }

    private static IEnumerable<(string Channel, JsonNode? Payload)> Frames(JsonNode? node, Dictionary<string, JsonNode?> names)
    {
        if (node is JsonObject obj)
        {
            if (obj["let"] is JsonObject bindings)
            {
                foreach (var pair in bindings)
                {
                    if (Resolve(pair.Value, names, out var value))
                    {
                        names[pair.Key] = value;
                    }
                }
            }
            if (obj["channel"] is JsonValue channel && channel.TryGetValue<string>(out var name) && obj.ContainsKey("payload"))
            {
                yield return (name, Resolve(obj["payload"], names, out var payload) ? payload : null);
            }
            foreach (var member in obj)
            {
                foreach (var frame in Frames(member.Value, names))
                {
                    yield return frame;
                }
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var member in array)
            {
                foreach (var frame in Frames(member, names))
                {
                    yield return frame;
                }
            }
        }
    }

    private static bool Resolve(JsonNode? node, Dictionary<string, JsonNode?> names, out JsonNode? result)
    {
        result = null;
        if (node is JsonObject obj)
        {
            if (obj["$var"] is JsonNode variable)
            {
                if (!names.TryGetValue(variable.ToString(), out var bound))
                {
                    return false;
                }
                result = bound?.DeepClone();
                return true;
            }
            if (obj["$join"] is JsonArray parts)
            {
                var text = "";
                foreach (var part in parts)
                {
                    if (!Resolve(part, names, out var value) || value is not JsonValue)
                    {
                        return false;
                    }
                    text += value.ToString();
                }
                result = JsonValue.Create(text);
                return true;
            }
            var resolved = new JsonObject();
            foreach (var member in obj)
            {
                if (!Resolve(member.Value, names, out var value))
                {
                    return false;
                }
                resolved.Add(member.Key, value);
            }
            result = resolved;
        }
        else if (node is JsonArray array)
        {
            var resolved = new JsonArray();
            foreach (var member in array)
            {
                if (!Resolve(member, names, out var value))
                {
                    return false;
                }
                resolved.Add(value);
            }
            result = resolved;
        }
        else
        {
            if (node is JsonValue value && value.TryGetValue<string>(out var text) && text == "_")
            {
                return false;
            }
            result = node?.DeepClone();
        }
        return true;
    }
}
