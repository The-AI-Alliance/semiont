using System.Text.Json;
using System.Text.Json.Serialization;

namespace Semiont.Types;

[JsonConverter(typeof(StatedJsonConverterFactory))]
public readonly struct Stated<T>
{
    private readonly T? value;

    public Stated(T? value)
    {
        this.value = value;
        IsPresent = true;
    }

    public bool IsPresent { get; }

    public T? Value => IsPresent ? value : throw new InvalidOperationException("An absent member has no value.");
}

internal sealed class StatedJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type type) => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Stated<>);

    public override JsonConverter CreateConverter(Type type, JsonSerializerOptions options) =>
        Activator.CreateInstance(typeof(StatedJsonConverter<>).MakeGenericType(type.GetGenericArguments())) is JsonConverter converter
            ? converter
            : throw new InvalidOperationException("Cannot construct a stated-member converter.");
}

internal sealed class StatedJsonConverter<T> : JsonConverter<Stated<T>>
{
    public override Stated<T> Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>
        new(JsonSerializer.Deserialize<T>(ref reader, options));

    public override void Write(Utf8JsonWriter writer, Stated<T> value, JsonSerializerOptions options)
    {
        if (!value.IsPresent)
        {
            throw new JsonException("An absent member must be omitted by its containing object.");
        }
        JsonSerializer.Serialize(writer, value.Value, options);
    }
}
