using System.Globalization;
using System.Text.Json;

namespace Semiont.Serialization;

/// <summary>The first thing wrong with a value: the way to the member it is at (the names of the members it is within,
/// and its own, joined by dots; empty for the value itself), and why.</summary>
internal sealed record Fault(string Member, FrameRefusalReason Reason)
{
    /// <summary>The fault of a value its decoder refuses that has no fault the table states: the value itself is
    /// malformed.</summary>
    internal static readonly Fault Undecoded = new("", FrameRefusalReason.Malformed);

    /// <summary>What every SDK says of the fault.</summary>
    public override string ToString() =>
        Reason == FrameRefusalReason.Lacks ? "it has no `" + Member + "`"
        : Member.Length == 0 ? "it is malformed"
        : "its `" + Member + "` is malformed";
}

// The first fault of a value as one of the protocol's component schemas. Every SDK holds what it reads to the table of
// what each schema requires, and names the first fault it finds the same way. The table is this SDK's copy of it
// (generators/Semiont.Generator/required-schemas.json), written by the rules of
// packages/codegen/schemas/required-shapes.mjs, which states what each part of a shape means and the order a reader
// walks them in. The generator adds what each payload type the bus registry makes requires (an envelope of a schema's
// response, and the empty payload) to it, by the same rules.
internal static partial class Required
{
    private static readonly Dictionary<string, Shape> Schemas = ParseTable();

    /// <summary>The first fault <paramref name="value"/> has as the component schema <paramref name="schema"/>, by the
    /// rules every SDK reads the table by; null when it has none.</summary>
    internal static Fault? FaultOf(string schema, JsonElement value) => FaultAt(Component(schema), value, "");

    /// <summary><paramref name="schema"/>, once the table is read and found to state it.</summary>
    internal static string Stated(string schema)
    {
        Component(schema);
        return schema;
    }

    private enum Kind { Object, Array, String, Integer, Number, Boolean, Null }

    /// <summary>One step of a pattern: at least <c>Min</c> of a text's next code points, and at most <c>Max</c> (null:
    /// any number), each in one of the ranges <c>Of</c>.</summary>
    private sealed record Step(IReadOnlyList<(int From, int To)> Of, int Min, int? Max);

    /// <summary>The member whose value names the variant of a union a value is.</summary>
    private sealed record Discriminator(string Property, IReadOnlyDictionary<string, int> Mapping);

    /// <summary>What a value must be. A part that is null is one the table does not state.</summary>
    private sealed record Shape
    {
        public string? Ref { get; init; }
        public IReadOnlyList<Kind>? Kinds { get; init; }
        public IReadOnlyList<JsonElement>? Enum { get; init; }
        public IReadOnlyList<Step>? Pattern { get; init; }
        public int? MinLength { get; init; }
        public int? MaxLength { get; init; }
        public double? Minimum { get; init; }
        public double? Maximum { get; init; }
        public int? MinItems { get; init; }
        public int? MaxItems { get; init; }
        public IReadOnlyList<string>? Required { get; init; }
        public IReadOnlyDictionary<string, Shape>? Members { get; init; }
        public IReadOnlyList<string>? Closed { get; init; }
        public Shape? Items { get; init; }
        public Shape? Values { get; init; }
        public IReadOnlyList<Shape>? OneOf { get; init; }
        public Discriminator? Discriminator { get; init; }
        public IReadOnlyList<Shape>? AllOf { get; init; }
    }

    private static Dictionary<string, Shape> ParseTable()
    {
        using var table = JsonDocument.Parse(Table);
        var schemas = table.RootElement.GetProperty("schemas").EnumerateObject()
            .ToDictionary(schema => schema.Name, schema => ParseShape(schema.Value), StringComparer.Ordinal);
        if (schemas.Count == 0) throw new InvalidOperationException("The table of what each schema requires holds none.");
        return schemas;
    }

    /// <summary>A shape of the table. A part this does not know is refused, so the walk cannot fall behind the table
    /// unseen.</summary>
    private static Shape ParseShape(JsonElement raw)
    {
        var shape = new Shape();
        foreach (var part in raw.EnumerateObject())
        {
            var value = part.Value;
            shape = part.Name switch
            {
                "ref" => shape with { Ref = Text(value) },
                "kinds" => shape with { Kinds = value.EnumerateArray().Select(ParseKind).ToArray() },
                "enum" => shape with { Enum = value.EnumerateArray().Select(listed => listed.Clone()).ToArray() },
                "pattern" => shape with { Pattern = value.EnumerateArray().Select(ParseStep).ToArray() },
                "minLength" => shape with { MinLength = value.GetInt32() },
                "maxLength" => shape with { MaxLength = value.GetInt32() },
                "minimum" => shape with { Minimum = value.GetDouble() },
                "maximum" => shape with { Maximum = value.GetDouble() },
                "minItems" => shape with { MinItems = value.GetInt32() },
                "maxItems" => shape with { MaxItems = value.GetInt32() },
                "required" => shape with { Required = value.EnumerateArray().Select(Text).ToArray() },
                "members" => shape with
                {
                    Members = value.EnumerateObject().ToDictionary(member => member.Name, member => ParseShape(member.Value), StringComparer.Ordinal),
                },
                "closed" => shape with { Closed = value.EnumerateArray().Select(Text).ToArray() },
                "items" => shape with { Items = ParseShape(value) },
                "values" => shape with { Values = ParseShape(value) },
                "oneOf" => shape with { OneOf = value.EnumerateArray().Select(ParseShape).ToArray() },
                "discriminator" => shape with
                {
                    Discriminator = new Discriminator(Text(value.GetProperty("property")), value.GetProperty("mapping").EnumerateObject()
                        .ToDictionary(named => named.Name, named => named.Value.GetInt32(), StringComparer.Ordinal)),
                },
                "allOf" => shape with { AllOf = value.EnumerateArray().Select(ParseShape).ToArray() },
                _ => throw new InvalidOperationException("A shape states " + part.Name + ", which the walk does not read."),
            };
        }
        return shape;
    }

    private static Kind ParseKind(JsonElement value) => Text(value) switch
    {
        "object" => Kind.Object,
        "array" => Kind.Array,
        "string" => Kind.String,
        "integer" => Kind.Integer,
        "number" => Kind.Number,
        "boolean" => Kind.Boolean,
        "null" => Kind.Null,
        var other => throw new InvalidOperationException(other + " is no kind of value."),
    };

    private static Step ParseStep(JsonElement value) => new(
        value.GetProperty("of").EnumerateArray().Select(range => (range[0].GetInt32(), range[1].GetInt32())).ToArray(),
        value.GetProperty("min").GetInt32(),
        value.TryGetProperty("max", out var most) ? most.GetInt32() : null);

    private static string Text(JsonElement value) => value.GetString() ?? throw new InvalidOperationException("A text is null.");

    private static Shape Component(string name) =>
        Schemas.TryGetValue(name, out var shape) ? shape : throw new InvalidOperationException(name + " is no component schema of the spec.");

    private static Shape Resolved(Shape shape) => shape.Ref is { } reference ? Resolved(Component(reference)) : shape;

    private static string Within(string way, string name) => way.Length == 0 ? name : way + "." + name;

    private static Kind KindOf(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => Kind.Null,
        JsonValueKind.True or JsonValueKind.False => Kind.Boolean,
        JsonValueKind.Number => Kind.Number,
        JsonValueKind.String => Kind.String,
        JsonValueKind.Array => Kind.Array,
        JsonValueKind.Object => Kind.Object,
        var other => throw new InvalidOperationException("JSON carries no " + other + " value."),
    };

    /// <summary>A number as JSON states it, where one too great for a double is infinite.</summary>
    private static double NumberOf(JsonElement value) => double.Parse(value.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary>Whether <paramref name="kinds"/> allow <paramref name="value"/>: none allow any, and an integer is a
    /// number with no fractional part.</summary>
    private static bool Allows(IReadOnlyList<Kind>? kinds, JsonElement value)
    {
        if (kinds is null || kinds.Contains(KindOf(value))) return true;
        if (value.ValueKind != JsonValueKind.Number || !kinds.Contains(Kind.Integer)) return false;
        var number = NumberOf(value);
        return double.IsFinite(number) && Math.Truncate(number) == number;
    }

    private static bool AllowsNull(IReadOnlyList<Kind>? kinds) => kinds is null || kinds.Contains(Kind.Null);

    /// <summary>Whether <paramref name="count"/> is at least <paramref name="least"/> and at most
    /// <paramref name="most"/>, where each is stated.</summary>
    private static bool Counted(double? least, double count, double? most) =>
        (least is not { } floor || count >= floor) && (most is not { } ceiling || count <= ceiling);

    /// <summary>Whether the code points from <paramref name="at"/> are of <paramref name="steps"/>: the first step
    /// takes as many of them as it may, and gives them back one by one until the steps after it take the rest.</summary>
    private static bool Matches(IReadOnlyList<Step> steps, int step, int[] points, int at)
    {
        if (step == steps.Count) return at == points.Length;
        var first = steps[step];
        var taken = 0;
        while (at + taken < points.Length && (first.Max is not { } most || taken < most)
            && first.Of.Any(range => range.From <= points[at + taken] && points[at + taken] <= range.To))
        {
            taken++;
        }
        for (; taken >= first.Min; taken--)
        {
            if (Matches(steps, step + 1, points, at + taken)) return true;
        }
        return false;
    }

    /// <summary>Whether <paramref name="value"/> is one of the shape's values, a text is of its pattern and has as many
    /// code points as it allows, a number is within its bounds, and an array has as many items as it allows.</summary>
    private static bool IsAsStated(Shape shape, JsonElement value)
    {
        if (shape.Enum is { } listed && !listed.Any(one => JsonElement.DeepEquals(one, value))) return false;
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var points = Text(value).EnumerateRunes().Select(rune => rune.Value).ToArray();
                return Counted(shape.MinLength, points.Length, shape.MaxLength)
                    && (shape.Pattern is not { } pattern || Matches(pattern, 0, points, 0));
            case JsonValueKind.Number:
                return Counted(shape.Minimum, NumberOf(value), shape.Maximum);
            case JsonValueKind.Array:
                return Counted(shape.MinItems, value.GetArrayLength(), shape.MaxItems);
            default:
                return true;
        }
    }

    /// <summary>The first fault <paramref name="value"/> has as a value of <paramref name="shape"/>, from
    /// <paramref name="way"/>.</summary>
    private static Fault? FaultAt(Shape shape, JsonElement value, string way)
    {
        var own = Resolved(shape);
        if (!Allows(own.Kinds, value) || !IsAsStated(own, value)) return new Fault(way, FrameRefusalReason.Malformed);
        if (value.ValueKind == JsonValueKind.Object && FaultOfMembers(own, value, way) is { } inMembers) return inMembers;
        if (value.ValueKind == JsonValueKind.Array && own.Items is { } items)
        {
            foreach (var item in value.EnumerateArray())
            {
                if (FaultAt(items, item, way) is { } inItem) return inItem;
            }
        }
        if (own.OneOf is { } variants && FaultOfOneOf(variants, own.Discriminator, value, way) is { } inVariant) return inVariant;
        if (own.AllOf is { } parts)
        {
            foreach (var part in parts)
            {
                if (FaultAt(part, value, way) is { } inPart) return inPart;
            }
        }
        return null;
    }

    /// <summary>The first fault of an object in the members the shape requires, in what its members are, in the
    /// members it may not carry, and in its values.</summary>
    private static Fault? FaultOfMembers(Shape shape, JsonElement value, string way)
    {
        if (shape.Required is { } required)
        {
            foreach (var name in required)
            {
                if (!value.TryGetProperty(name, out var held)
                    || (held.ValueKind == JsonValueKind.Null && shape.Members is { } stated && stated.TryGetValue(name, out var member)
                        && !AllowsNull(Resolved(member).Kinds)))
                {
                    return new Fault(Within(way, name), FrameRefusalReason.Lacks);
                }
            }
        }
        if (shape.Members is { } members)
        {
            foreach (var (name, member) in members.OrderBy(pair => pair.Key, CodePoints.Order))
            {
                if (!value.TryGetProperty(name, out var held) || held.ValueKind == JsonValueKind.Null) continue;
                if (FaultAt(member, held, Within(way, name)) is { } inMember) return inMember;
            }
        }
        var names = value.EnumerateObject().Select(property => property.Name).Order(CodePoints.Order).ToArray();
        if (shape.Closed is { } closed && names.FirstOrDefault(name => !closed.Contains(name, StringComparer.Ordinal)) is { } unnamed)
        {
            return new Fault(Within(way, unnamed), FrameRefusalReason.Malformed);
        }
        if (shape.Values is { } values)
        {
            foreach (var name in names)
            {
                if (FaultAt(values, value.GetProperty(name), way) is { } inValue) return inValue;
            }
        }
        return null;
    }

    /// <summary>The fault <paramref name="value"/> has as one of a union's <paramref name="variants"/>: the variant its
    /// discriminator names, or else each variant whose kinds allow it. None when one of them has none; the first one's
    /// when each has one; and a value no variant allows is malformed.</summary>
    private static Fault? FaultOfOneOf(IReadOnlyList<Shape> variants, Discriminator? discriminator, JsonElement value, string way)
    {
        IReadOnlyList<Shape> candidates = variants.Where(variant => Allows(Resolved(variant).Kinds, value)).ToArray();
        if (value.ValueKind == JsonValueKind.Object && discriminator is not null
            && value.TryGetProperty(discriminator.Property, out var named) && named.ValueKind == JsonValueKind.String
            && named.GetString() is { } variantName && discriminator.Mapping.TryGetValue(variantName, out var at)
            && at >= 0 && at < variants.Count)
        {
            candidates = [variants[at]];
        }
        if (candidates.Count == 0) return new Fault(way, FrameRefusalReason.Malformed);
        Fault? first = null;
        foreach (var candidate in candidates)
        {
            if (FaultAt(candidate, value, way) is not { } fault) return null;
            if (first is null) first = fault;
        }
        return first;
    }
}
