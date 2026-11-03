using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Semiont.Generator;

internal sealed class Models
{
    private const string Types = "global::Semiont.Types.";
    private const string Json = "global::System.Text.Json.";
    private const string Wire = "global::Semiont.Serialization.WireJson";
    private readonly Dictionary<string, JsonElement> definitions;
    private readonly HashSet<string> identifiers;
    private readonly Dictionary<string, string> written = new Dictionary<string, string>(StringComparer.Ordinal);
    private readonly Dictionary<string, string> inlined = new Dictionary<string, string>(StringComparer.Ordinal);

    internal Models(IReadOnlyDictionary<string, JsonElement> definitions, HashSet<string> identifiers)
    {
        this.definitions = definitions.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        this.identifiers = identifiers;
    }

    internal IReadOnlyDictionary<string, JsonElement> Schemas => definitions;

    internal IReadOnlyDictionary<string, string> Emit()
    {
        foreach (var name in definitions.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray())
        {
            Named(name);
        }
        return written;
    }

    private static string Literal(string text) => JsonSerializer.Serialize(text);

    private static string Text(JsonElement schema, string name) => schema.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
        ? value.GetString() ?? throw new InvalidOperationException("A schema string is null.") : "";

    private static bool Flag(JsonElement schema, string name) => schema.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static string Pascal(string text)
    {
        text = text.Replace("+", " Plus ");
        var name = string.Concat(Regex.Matches(text, "[A-Za-z0-9]+").Cast<Match>().Select(match => char.ToUpperInvariant(match.Value[0]) + match.Value.Substring(1)));
        if (name.Length == 0 || char.IsDigit(name[0]))
        {
            name = "Value" + name;
        }
        return name;
    }

    private static string? Reference(JsonElement schema)
    {
        if (!schema.TryGetProperty("$ref", out var reference))
        {
            return null;
        }
        var name = reference.GetString() ?? throw new InvalidOperationException("A schema reference is null.");
        name = name.Substring(name.LastIndexOf('/') + 1);
        return name.EndsWith(".json", StringComparison.Ordinal) ? name.Substring(0, name.Length - 5) : name;
    }

    private JsonElement Definition(string name) => definitions.TryGetValue(name, out var schema)
        ? schema : throw new InvalidOperationException("No component schema names " + name + ".");

    private bool PlainText(JsonElement schema)
    {
        if (Reference(schema) is string name)
        {
            return PlainText(Definition(name));
        }
        return Text(schema, "type") == "string" && !schema.TryGetProperty("enum", out _);
    }

    private string Named(string name)
    {
        if (identifiers.Contains(name))
        {
            return "global::Semiont.Identifiers." + name;
        }
        var schema = Definition(name);
        if (PlainText(schema))
        {
            return "string";
        }
        if (!written.ContainsKey(name))
        {
            written.Add(name, "");
            written[name] = Declare(name, schema);
        }
        return Types + name;
    }

    private string Inline(string owner, string property, JsonElement schema)
    {
        var key = owner + "." + property;
        if (inlined.TryGetValue(key, out var known))
        {
            return Types + known;
        }
        var name = owner + Pascal(property);
        while (definitions.ContainsKey(name) || written.ContainsKey(name))
        {
            name += "Value";
        }
        inlined.Add(key, name);
        definitions.Add(name, schema);
        written.Add(name, "");
        written[name] = Declare(name, schema);
        return Types + name;
    }

    private string TypeOf(string owner, string property, JsonElement schema)
    {
        if (Reference(schema) is string name)
        {
            return Named(name);
        }
        if (schema.TryGetProperty("allOf", out var parts))
        {
            if (parts.GetArrayLength() == 1)
            {
                return TypeOf(owner, property, parts[0]);
            }
            return Inline(owner, property, schema);
        }
        if (schema.TryGetProperty("oneOf", out _) || schema.TryGetProperty("anyOf", out _))
        {
            return Inline(owner, property, schema);
        }
        switch (Text(schema, "type"))
        {
            case "string": return schema.TryGetProperty("enum", out _) ? Inline(owner, property, schema) : "string";
            case "integer": return "long";
            case "number": return "double";
            case "boolean": return "bool";
            case "array": return "global::System.Collections.Generic.IReadOnlyList<" + TypeOf(owner, property + "Item", schema.GetProperty("items")) + ">";
            case "object":
                if (schema.TryGetProperty("properties", out var properties) && properties.EnumerateObject().Any() ||
                    schema.TryGetProperty("maxProperties", out var maximum) && maximum.GetInt32() == 0 ||
                    schema.TryGetProperty("additionalProperties", out var more) && more.ValueKind == JsonValueKind.False)
                {
                    return Inline(owner, property, schema);
                }
                if (schema.TryGetProperty("additionalProperties", out var values) && values.ValueKind == JsonValueKind.Object)
                {
                    return "global::System.Collections.Generic.IReadOnlyDictionary<string, " + TypeOf(owner, property + "Value", values) + ">";
                }
                return Json + "JsonElement";
            case "":
                if (!schema.EnumerateObject().Any())
                {
                    return Json + "JsonElement";
                }
                break;
        }
        throw new InvalidOperationException(owner + "." + property + " has an unsupported type shape.");
    }

    private string Declare(string name, JsonElement schema)
    {
        var code = new StringBuilder("// <auto-generated/>\n#nullable enable\nnamespace Semiont.Types;\n\n");
        if (schema.TryGetProperty("enum", out var values))
        {
            Enum(code, name, values);
        }
        else if (schema.TryGetProperty("oneOf", out var alternatives) || schema.TryGetProperty("anyOf", out alternatives))
        {
            Union(code, name, alternatives);
        }
        else
        {
            Object(code, name, schema);
        }
        return code.ToString();
    }

    private static void ConverterStart(StringBuilder code, string name)
    {
        code.Append("internal sealed class ").Append(name).Append("JsonConverter : ").Append(Json).Append("Serialization.JsonConverter<").Append(name).Append(">\n{\n");
        code.Append("    public override ").Append(name).Append(" Read(ref ").Append(Json).Append("Utf8JsonReader reader, global::System.Type type, ").Append(Json).Append("JsonSerializerOptions options)\n    {\n");
        code.Append("        using var document = ").Append(Json).Append("JsonDocument.ParseValue(ref reader);\n        var root = document.RootElement;\n");
        code.Append("        ").Append(Wire).Append(".Validate(").Append(Literal(name)).Append(", root);\n");
    }

    private static void WriterStart(StringBuilder code, string name)
    {
        code.Append("    }\n\n    public override void Write(").Append(Json).Append("Utf8JsonWriter writer, ").Append(name).Append(" value, ").Append(Json).Append("JsonSerializerOptions options)\n    {\n");
    }

    private static void Attribute(StringBuilder code, string name) => code.Append('[').Append(Json).Append("Serialization.JsonConverter(typeof(").Append(name).Append("JsonConverter))]\n");

    private static void Enum(StringBuilder code, string name, JsonElement values)
    {
        var members = values.EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("An enumeration contains a non-string.")).ToArray();
        if (members.Select(Pascal).Distinct(StringComparer.Ordinal).Count() != members.Length)
        {
            throw new InvalidOperationException(name + " has colliding C# enumeration names.");
        }
        Attribute(code, name);
        code.Append("public enum ").Append(name).Append("\n{\n");
        foreach (var member in members)
        {
            code.Append("    ").Append(Pascal(member)).Append(",\n");
        }
        code.Append("}\n\n");
        ConverterStart(code, name);
        code.Append("        return root.GetString() switch\n        {\n");
        foreach (var member in members)
        {
            code.Append("            ").Append(Literal(member)).Append(" => ").Append(name).Append('.').Append(Pascal(member)).Append(",\n");
        }
        code.Append("            _ => throw new ").Append(Json).Append("JsonException(\"Unknown enumeration value.\"),\n        };\n");
        WriterStart(code, name);
        code.Append("        writer.WriteStringValue(value switch\n        {\n");
        foreach (var member in members)
        {
            code.Append("            ").Append(name).Append('.').Append(Pascal(member)).Append(" => ").Append(Literal(member)).Append(",\n");
        }
        code.Append("            _ => throw new ").Append(Json).Append("JsonException(\"Unknown enumeration value.\"),\n        });\n    }\n}\n");
    }

    private void CollectObject(JsonElement schema, Dictionary<string, JsonElement> properties, List<string> required, ref bool open)
    {
        if (Reference(schema) is string reference)
        {
            CollectObject(Definition(reference), properties, required, ref open);
            return;
        }
        if (schema.TryGetProperty("allOf", out var parts))
        {
            foreach (var part in parts.EnumerateArray())
            {
                CollectObject(part, properties, required, ref open);
            }
        }
        if (schema.TryGetProperty("properties", out var members))
        {
            foreach (var member in members.EnumerateObject())
            {
                properties[member.Name] = member.Value;
            }
        }
        if (schema.TryGetProperty("required", out var requirements))
        {
            foreach (var member in requirements.EnumerateArray())
            {
                var name = member.GetString() ?? throw new InvalidOperationException("A required member has no name.");
                if (!required.Contains(name))
                {
                    required.Add(name);
                }
            }
        }
        open |= Flag(schema, "additionalProperties");
    }

    private void Object(StringBuilder code, string name, JsonElement schema)
    {
        var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var required = new List<string>();
        var open = false;
        CollectObject(schema, properties, required, ref open);
        if (Text(schema, "type") != "object" && !schema.TryGetProperty("allOf", out _))
        {
            throw new InvalidOperationException(name + " is not an object schema.");
        }
        var fields = properties.OrderBy(property => property.Key, StringComparer.Ordinal).Select(property =>
        {
            var field = Pascal(property.Key);
            if (field == name)
            {
                field += "Value";
            }
            var isRequired = required.Contains(property.Key);
            var nullable = Flag(property.Value, "nullable");
            var constant = isRequired && !nullable && property.Value.TryGetProperty("enum", out var values) && values.GetArrayLength() == 1 && values[0].ValueKind == JsonValueKind.String
                ? values[0].GetString() : null;
            var type = constant is null ? TypeOf(name, field, property.Value) : "string";
            return new Field(property.Key, field, type, isRequired, nullable, constant);
        }).ToArray();
        if (fields.Select(field => field.Name).Distinct(StringComparer.Ordinal).Count() != fields.Length || open && fields.Any(field => field.Name == "AdditionalProperties"))
        {
            throw new InvalidOperationException(name + " has colliding C# property names.");
        }
        Attribute(code, name);
        code.Append("public sealed record ").Append(name).Append("\n{\n");
        foreach (var field in fields)
        {
            code.Append("    public ");
            if (field.Constant is string constant)
            {
                code.Append("string ").Append(field.Name).Append(" => ").Append(Literal(constant)).Append(";\n");
                continue;
            }
            if (field.Required)
            {
                code.Append("required ");
            }
            var type = field.Type + (!field.Required || field.Nullable ? "?" : "");
            if (!field.Required && field.Nullable)
            {
                type = Types + "Stated<" + field.Type + "?>";
            }
            code.Append(type).Append(' ').Append(field.Name).Append(" { get; init; }\n");
        }
        if (open)
        {
            code.Append("    public global::System.Collections.Generic.IReadOnlyDictionary<string, ").Append(Json).Append("JsonElement> AdditionalProperties { get; init; } = new global::System.Collections.Generic.Dictionary<string, ").Append(Json).Append("JsonElement>();\n");
        }
        code.Append("}\n\n");
        ConverterStart(code, name);
        code.Append("        return new ").Append(name).Append("\n        {\n");
        var index = 0;
        foreach (var field in fields.Where(field => field.Constant is null))
        {
            var value = "p" + index++;
            var read = Wire + ".Read<" + field.Type + ">(" + value + ", options)";
            if (field.Nullable)
            {
                read = value + ".ValueKind == " + Json + "JsonValueKind.Null ? (" + field.Type + "?)null : " + read;
            }
            code.Append("            ").Append(field.Name).Append(" = ");
            if (field.Required)
            {
                if (field.Nullable)
                {
                    code.Append("root.GetProperty(").Append(Literal(field.Wire)).Append(").ValueKind == ").Append(Json).Append("JsonValueKind.Null ? (").Append(field.Type).Append("?)null : ");
                }
                code.Append(Wire).Append(".ReadMember<").Append(field.Type).Append(">(root, ").Append(Literal(field.Wire)).Append(", options)");
            }
            else
            {
                code.Append("root.TryGetProperty(").Append(Literal(field.Wire)).Append(", out var ").Append(value).Append(") ? ");
                if (field.Nullable)
                {
                    code.Append("new ").Append(Types).Append("Stated<").Append(field.Type).Append("?>(").Append(read).Append(") : default");
                }
                else
                {
                    code.Append(read).Append(" : null");
                }
            }
            code.Append(",\n");
        }
        if (open)
        {
            code.Append("            AdditionalProperties = ").Append(Wire).Append(".Extra(root, new string[] { ").Append(string.Join(", ", fields.Select(field => Literal(field.Wire)))).Append(" }),\n");
        }
        code.Append("        };\n");
        WriterStart(code, name);
        code.Append("        var fields = new global::System.Collections.Generic.Dictionary<string, ").Append(Json).Append("JsonElement>();\n");
        foreach (var field in fields)
        {
            var access = "value." + field.Name;
            if (!field.Required)
            {
                code.Append("        if (").Append(access).Append(field.Nullable ? ".IsPresent" : " is not null").Append(")\n        {\n");
            }
            code.Append("        fields.Add(").Append(Literal(field.Wire)).Append(", ").Append(Json).Append("JsonSerializer.SerializeToElement(").Append(access).Append(!field.Required && field.Nullable ? ".Value" : "").Append(", options));\n");
            if (!field.Required)
            {
                code.Append("        }\n");
            }
        }
        if (open)
        {
            code.Append("        foreach (var pair in value.AdditionalProperties) { fields.Add(pair.Key, pair.Value); }\n");
        }
        code.Append("        ").Append(Wire).Append(".WriteObject(writer, ").Append(Literal(name)).Append(", fields);\n    }\n}\n");
    }

    private static string ObjectVariant(JsonElement schema)
    {
        if (schema.TryGetProperty("properties", out var properties))
        {
            foreach (var property in properties.EnumerateObject())
            {
                if (property.Value.TryGetProperty("enum", out var values) && values.GetArrayLength() == 1 && values[0].ValueKind == JsonValueKind.String)
                {
                    return values[0].GetString() ?? throw new InvalidOperationException("A union tag is null.");
                }
            }
        }
        return "Object";
    }

    private void Union(StringBuilder code, string name, JsonElement alternatives)
    {
        var variants = alternatives.EnumerateArray().Select(alternative =>
        {
            var reference = Reference(alternative);
            var variant = reference ?? (Text(alternative, "type") == "array" ? "Array" : Text(alternative, "type") == "string" ? "Text" : ObjectVariant(alternative));
            return new KeyValuePair<string, string>(Pascal(variant) + "Case", TypeOf(name, variant, alternative));
        }).ToArray();
        if (variants.Select(variant => variant.Key).Distinct(StringComparer.Ordinal).Count() != variants.Length)
        {
            throw new InvalidOperationException(name + " has colliding C# union cases.");
        }
        Attribute(code, name);
        code.Append("public closed record ").Append(name).Append("\n{\n");
        foreach (var variant in variants)
        {
            code.Append("    public sealed record ").Append(variant.Key).Append('(').Append(variant.Value).Append(" Value) : ").Append(name).Append(";\n");
        }
        code.Append("}\n\n");
        ConverterStart(code, name);
        code.Append("        var variant = ").Append(Wire).Append(".Variant(").Append(Literal(name)).Append(", root);\n        return variant switch\n        {\n");
        for (var index = 0; index < variants.Length; index++)
        {
            code.Append("            ").Append(index).Append(" => new ").Append(name).Append('.').Append(variants[index].Key).Append('(').Append(Wire).Append(".Read<").Append(variants[index].Value).Append(">(root, options)),\n");
        }
        code.Append("            _ => throw new ").Append(Json).Append("JsonException(\"No matching union variant.\"),\n        };\n");
        WriterStart(code, name);
        code.Append("        switch (value)\n        {\n");
        foreach (var variant in variants)
        {
            code.Append("            case ").Append(name).Append('.').Append(variant.Key).Append(" selected: ").Append(Json).Append("JsonSerializer.Serialize(writer, selected.Value, options); break;\n");
        }
        code.Append("            default: throw new ").Append(Json).Append("JsonException(\"Unknown union variant.\");\n        }\n    }\n}\n");
    }

    private sealed class Field
    {
        internal Field(string wire, string name, string type, bool required, bool nullable, string? constant)
        {
            Wire = wire;
            Name = name;
            Type = type;
            Required = required;
            Nullable = nullable;
            Constant = constant;
        }
        internal string Wire { get; }
        internal string Name { get; }
        internal string Type { get; }
        internal bool Required { get; }
        internal bool Nullable { get; }
        internal string? Constant { get; }
    }
}
