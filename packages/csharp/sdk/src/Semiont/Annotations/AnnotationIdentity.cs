using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Annotations;

internal static class AnnotationIdentity
{
    private static readonly Comparer<string> CodePointOrder = Comparer<string>.Create((left, right) =>
        Encoding.UTF8.GetBytes(left ?? "").AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(right ?? "")));

    internal static AnnotationId Derive(ResourceId resourceId, Motivation motivation, string anchor, JsonElement? body)
    {
        var values = new Dictionary<string, JsonElement>
        {
            ["anchor"] = JsonSerializer.SerializeToElement(anchor),
            ["motivation"] = JsonSerializer.SerializeToElement(motivation),
            ["resourceId"] = JsonSerializer.SerializeToElement(resourceId),
        };
        if (body is JsonElement value) values.Add("body", value);
        var json = new StringBuilder();
        Write(json, JsonSerializer.SerializeToElement(values));
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString()));
        return AnnotationId.Parse(Convert.ToBase64String(hash).Replace('+', '-').Replace('/', '_')[..21]);
    }

    private static void Write(StringBuilder result, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                result.Append('{');
                var first = true;
                foreach (var property in value.EnumerateObject().OrderBy(property => property.Name, CodePointOrder))
                {
                    if (!first) result.Append(',');
                    first = false;
                    Quote(result, property.Name);
                    result.Append(':');
                    Write(result, property.Value);
                }
                result.Append('}');
                break;
            case JsonValueKind.Array:
                result.Append('[');
                var separate = false;
                foreach (var item in value.EnumerateArray())
                {
                    if (separate) result.Append(',');
                    separate = true;
                    Write(result, item);
                }
                result.Append(']');
                break;
            case JsonValueKind.String:
                Quote(result, value.GetString() ?? throw new InvalidOperationException("Missing string"));
                break;
            case JsonValueKind.Number:
                if (!BigInteger.TryParse(value.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture, out var whole))
                    throw new ArgumentException("An annotation's identity uses whole numbers.");
                result.Append(whole.ToString(CultureInfo.InvariantCulture));
                break;
            case JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null:
                result.Append(value.GetRawText());
                break;
            default: throw new ArgumentException("An annotation's identity must be JSON.");
        }
    }

    private static void Quote(StringBuilder result, string text)
    {
        result.Append('"');
        foreach (var character in text)
        {
            switch (character)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\t': result.Append("\\t"); break;
                case '\n': result.Append("\\n"); break;
                case '\f': result.Append("\\f"); break;
                case '\r': result.Append("\\r"); break;
                case < ' ': result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture)); break;
                default: result.Append(character); break;
            }
        }
        result.Append('"');
    }
}
