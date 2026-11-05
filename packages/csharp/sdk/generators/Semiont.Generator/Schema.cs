using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Semiont.Generator;

internal static class Schema
{
    private static readonly HashSet<string> Keywords = new HashSet<string>(StringComparer.Ordinal)
    {
        "$ref", "$comment", "type", "description", "title", "properties", "required", "additionalProperties",
        "items", "enum", "oneOf", "anyOf", "allOf", "format", "nullable", "pattern", "minimum", "maximum",
        "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "maxProperties", "default", "example",
        "examples", "discriminator", "deprecated", "readOnly", "writeOnly",
    };

    internal static void Validate(JsonElement schema, string path)
    {
        if (schema.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException(path + " is not a schema object.");
        }
        foreach (var member in schema.EnumerateObject())
        {
            if (!Keywords.Contains(member.Name))
            {
                throw new InvalidOperationException(path + " uses unsupported schema keyword " + member.Name + ".");
            }
            switch (member.Name)
            {
                case "type":
                    if (member.Value.ValueKind != JsonValueKind.String ||
                        member.Value.GetString() is not ("string" or "integer" or "number" or "boolean" or "object" or "array"))
                    {
                        throw new InvalidOperationException(path + " has an unsupported type.");
                    }
                    break;
                case "format":
                    if (member.Value.GetString() is not ("uri" or "date-time" or "binary"))
                    {
                        throw new InvalidOperationException(path + " has an unsupported format.");
                    }
                    break;
                case "properties":
                    foreach (var property in member.Value.EnumerateObject())
                    {
                        Validate(property.Value, path + "." + property.Name);
                    }
                    break;
                case "items":
                    Validate(member.Value, path + "[]");
                    break;
                case "additionalProperties":
                    if (member.Value.ValueKind == JsonValueKind.Object)
                    {
                        Validate(member.Value, path + ".*");
                    }
                    else if (member.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        throw new InvalidOperationException(path + " has unsupported additionalProperties.");
                    }
                    break;
                case "oneOf":
                case "anyOf":
                case "allOf":
                    foreach (var alternative in member.Value.EnumerateArray())
                    {
                        Validate(alternative, path + "." + member.Name);
                    }
                    break;
            }
        }
    }
}
