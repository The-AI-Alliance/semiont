using System.Text.Json;
using System.Text.RegularExpressions;

namespace Semiont.Serialization;

internal static partial class WireJson
{
    private static readonly JsonDocument Schemas = JsonDocument.Parse(SchemaSource);

    private static JsonElement Definition(string name) => Schemas.RootElement.GetProperty(name);

    internal static void Validate(string name, JsonElement value) => Validate(Definition(name), value, name);

    private static void Validate(JsonElement schema, JsonElement value, string path)
    {
        if (schema.TryGetProperty("$ref", out var reference))
        {
            var target = reference.GetString() ?? throw new JsonException(path + ": null reference");
            Validate(Definition(Path.GetFileNameWithoutExtension(target)), value, path);
            return;
        }
        if (value.ValueKind == JsonValueKind.Null && schema.TryGetProperty("nullable", out var nullable) && nullable.GetBoolean())
        {
            return;
        }
        if (schema.TryGetProperty("allOf", out var parts))
        {
            foreach (var part in parts.EnumerateArray())
            {
                Validate(part, value, path);
            }
        }
        if (schema.TryGetProperty("oneOf", out var alternatives) || schema.TryGetProperty("anyOf", out alternatives))
        {
            Select(alternatives, value, path);
            return;
        }
        if (schema.TryGetProperty("enum", out var choices) && !choices.EnumerateArray().Any(choice => JsonElement.DeepEquals(choice, value)))
        {
            throw new JsonException(path + ": unknown enumeration value");
        }
        if (!schema.TryGetProperty("type", out var type))
        {
            return;
        }
        var matches = type.GetString() switch
        {
            "object" => value.ValueKind == JsonValueKind.Object,
            "array" => value.ValueKind == JsonValueKind.Array,
            "string" => value.ValueKind == JsonValueKind.String,
            "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
            "number" => value.ValueKind == JsonValueKind.Number,
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            _ => false,
        };
        if (!matches)
        {
            throw new JsonException(path + ": expected " + type.GetString());
        }
        if (value.ValueKind == JsonValueKind.Object)
        {
            if (schema.TryGetProperty("required", out var required))
            {
                foreach (var member in required.EnumerateArray())
                {
                    var name = member.GetString() ?? throw new JsonException(path + ": null required member");
                    if (!value.TryGetProperty(name, out _))
                    {
                        throw new JsonException(path + "." + name + ": missing required member");
                    }
                }
            }
            var hasProperties = schema.TryGetProperty("properties", out var properties);
            foreach (var member in value.EnumerateObject())
            {
                if (hasProperties && properties.TryGetProperty(member.Name, out var child))
                {
                    Validate(child, member.Value, path + "." + member.Name);
                }
                else if (schema.TryGetProperty("additionalProperties", out var additional))
                {
                    if (additional.ValueKind == JsonValueKind.False)
                    {
                        throw new JsonException(path + "." + member.Name + ": unknown member");
                    }
                    if (additional.ValueKind == JsonValueKind.Object)
                    {
                        Validate(additional, member.Value, path + "." + member.Name);
                    }
                }
            }
            Bound(schema, "maxProperties", value.EnumerateObject().Count(), path, false);
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            if (schema.TryGetProperty("items", out var items))
            {
                var index = 0;
                foreach (var item in value.EnumerateArray())
                {
                    Validate(items, item, path + "[" + index++ + "]");
                }
            }
            if (schema.TryGetProperty("uniqueItems", out var unique) && unique.GetBoolean())
            {
                var members = value.EnumerateArray().ToArray();
                for (var index = 0; index < members.Length; index++)
                {
                    if (members.Take(index).Any(previous => JsonElement.DeepEquals(previous, members[index])))
                    {
                        throw new JsonException(path + "[" + index + "]: duplicate item");
                    }
                }
            }
            Bound(schema, "minItems", value.GetArrayLength(), path, true);
            Bound(schema, "maxItems", value.GetArrayLength(), path, false);
        }
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString() ?? throw new JsonException(path + ": null string");
            Bound(schema, "minLength", text.Length, path, true);
            Bound(schema, "maxLength", text.Length, path, false);
            if (schema.TryGetProperty("pattern", out var pattern) && !Regex.IsMatch(text, pattern.GetString() ?? throw new JsonException(path + ": null pattern"), RegexOptions.ECMAScript, TimeSpan.FromSeconds(1)))
            {
                throw new JsonException(path + ": pattern mismatch");
            }
        }
        if (value.ValueKind == JsonValueKind.Number)
        {
            Bound(schema, "minimum", value.GetDouble(), path, true);
            Bound(schema, "maximum", value.GetDouble(), path, false);
        }
    }

    private static void Bound(JsonElement schema, string keyword, double value, string path, bool minimum)
    {
        if (schema.TryGetProperty(keyword, out var bound) && (minimum ? value < bound.GetDouble() : value > bound.GetDouble()))
        {
            throw new JsonException(path + ": violates " + keyword);
        }
    }

    private static int Select(JsonElement alternatives, JsonElement value, string path)
    {
        var index = 0;
        var errors = new List<string>();
        foreach (var alternative in alternatives.EnumerateArray())
        {
            try
            {
                Validate(alternative, value, path);
                return index;
            }
            catch (JsonException error)
            {
                errors.Add(error.Message);
                index++;
            }
        }
        throw new JsonException(path + ": no matching union variant: " + string.Join("; ", errors));
    }

    internal static int Variant(string name, JsonElement value)
    {
        var schema = Definition(name);
        return Select(schema.TryGetProperty("oneOf", out var alternatives) ? alternatives : schema.GetProperty("anyOf"), value, name);
    }

    internal static T Read<T>(JsonElement value, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize<T>(value, options) is T result ? result : throw new JsonException("Unexpected null value");

    internal static T ReadMember<T>(JsonElement root, string member, JsonSerializerOptions options)
    {
        if (!root.TryGetProperty(member, out var value))
        {
            throw new JsonException(member + ": missing required member");
        }
        return Read<T>(value, options);
    }

    internal static IReadOnlyDictionary<string, JsonElement> Extra(JsonElement root, string[] known) =>
        root.EnumerateObject().Where(member => !known.Contains(member.Name, StringComparer.Ordinal)).ToDictionary(member => member.Name, member => member.Value.Clone());

    internal static void WriteObject(Utf8JsonWriter writer, string name, Dictionary<string, JsonElement> fields)
    {
        var value = JsonSerializer.SerializeToElement(fields);
        Validate(name, value);
        value.WriteTo(writer);
    }
}
