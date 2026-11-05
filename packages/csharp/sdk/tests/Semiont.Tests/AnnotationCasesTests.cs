using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Annotations;
using Semiont.Identifiers;
using Semiont.Types;
using Xunit;
using static Semiont.Annotations.AnnotationTools;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    private static readonly JsonSerializerOptions AnnotationCaseOptions = new() { PropertyNameCaseInsensitive = true };

    [Fact]
    public void AnnotationReadersRunTheSharedCases()
    {
        using var table = ReadSpec("annotations/reader-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var annotation = Required<Annotation>(row.GetProperty("annotation"));
            var selector = TargetSelector(annotation.Target);
            var actual = JsonSerializer.SerializeToElement(new
            {
                bodySource = BodySource(annotation.Body),
                isBodyResolved = IsBodyResolved(annotation.Body),
                targetSource = TargetSource(annotation.Target),
                targetSelector = selector,
                isHighlight = IsHighlight(annotation),
                isReference = IsReference(annotation),
                isAssessment = IsAssessment(annotation),
                isComment = IsComment(annotation),
                isTag = IsTag(annotation),
                commentText = CommentText(annotation),
                isStubReference = IsStubReference(annotation),
                isResolvedReference = IsResolvedReference(annotation),
                exactText = ExactText(selector),
                annotationExactText = AnnotationExactText(annotation),
                textQuoteSelector = TextQuoteSelector(selector),
                entityTypes = EntityTypes(annotation),
                tagCategory = TagCategory(annotation),
                tagSchemaId = TagSchemaId(annotation),
            });
            Assert.Equal(table.RootElement.GetProperty("readers").EnumerateArray().Select(value => value.GetString()).Order(),
                actual.EnumerateObject().Select(property => property.Name).Order());
            foreach (var property in row.GetProperty("reads").EnumerateObject())
                Assert.True(JsonElement.DeepEquals(property.Value, actual.GetProperty(property.Name)), Text(row, "why") + ": " + property.Name);
        }
    }

    [Fact]
    public void AnnotationIdsRunTheSharedCases()
    {
        using var table = ReadSpec("annotations/id-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var id = AnnotationIdentity.Derive(row.GetProperty("resourceId").Deserialize<ResourceId>(),
                row.GetProperty("motivation").Deserialize<Motivation>(), Text(row, "anchor"),
                row.TryGetProperty("body", out var body) ? body : null);
            Assert.Equal(Text(row, "id"), id.Value);
        }
    }

    [Theory]
    [InlineData("cases")]
    [InlineData("resources")]
    public void AnnotationBuildersRunTheSharedCases(string section)
    {
        using var table = ReadSpec("annotations/builder-cases.json");
        foreach (var row in table.RootElement.GetProperty(section).EnumerateArray())
        {
            var resource = row.GetProperty("resourceId").Deserialize<ResourceId>();
            var motivation = row.GetProperty("motivation").Deserialize<Motivation>();
            var generator = row.TryGetProperty("generator", out var agent) ? Required<Agent>(agent) : null;
            var body = row.TryGetProperty("body", out var bodies) ? Required<AnnotationBodies>(bodies) : null;
            if (section == "resources")
            {
                ExpectAnnotation(AnnotationOfResource(new OfResource(resource, motivation, generator, body)), row);
                continue;
            }

            var source = row.TryGetProperty("text", out var plain)
                ? (Spanned)new Spanned.Text(plain.GetString() ?? throw new InvalidOperationException("Missing source text"))
                : new Spanned.Anchored(Required<AnchoredText>(row.GetProperty("anchored")));
            var stated = row.GetProperty("span");
            if (!stated.GetProperty("start").TryGetInt32(out _) || !stated.GetProperty("end").TryGetInt32(out _))
            {
                // TextSpan's offsets are integers, so a fraction is rejected at the input boundary.
                Assert.Equal("span-out-of-range", Text(row, "refused"));
                Assert.Throws<JsonException>(() => stated.Deserialize<TextSpan>(AnnotationCaseOptions));
                continue;
            }

            var span = stated.Deserialize<TextSpan>(AnnotationCaseOptions) ?? throw new InvalidOperationException("Missing span");
            var input = new OfSpan(resource, motivation, generator ?? throw new InvalidOperationException("Missing generator"), span, source, body);
            if (row.TryGetProperty("refused", out var code))
            {
                var error = Assert.Throws<SpanRefusedError>(() => AnnotationOfSpan(input));
                Assert.Equal(code.GetString(), error.Code);
            }
            else ExpectAnnotation(AnnotationOfSpan(input), row);
        }

        static void ExpectAnnotation(Annotation annotation, JsonElement row)
        {
            var actual = JsonSerializer.SerializeToNode(annotation)?.AsObject() ?? throw new InvalidOperationException("No annotation");
            Assert.True(actual.Remove("created"));
            Assert.True(JsonElement.DeepEquals(row.GetProperty("annotation"), JsonSerializer.SerializeToElement(actual)),
                Text(row, "why") + ": " + actual.ToJsonString());
        }
    }

    [Fact]
    public void QuoteRecoveryRunsTheSharedCases()
    {
        using var table = ReadSpec("annotations/reconcile-cases.json");
        var methods = new HashSet<string>();
        var qualities = new HashSet<string>();
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var quote = row.GetProperty("quoted").Deserialize<QuotedText>(AnnotationCaseOptions) ?? throw new InvalidOperationException("Missing quote");
            var result = Reconcile(Text(row, "text"), quote);
            var expected = row.GetProperty("reconciled");
            if (expected.ValueKind == JsonValueKind.Null)
            {
                Assert.Null(result);
                continue;
            }
            Assert.NotNull(result);
            var method = JsonNamingPolicy.KebabCaseLower.ConvertName(result.AnchorMethod.ToString());
            methods.Add(Text(expected, "anchorMethod"));
            Assert.Equal(Text(expected, "anchorMethod"), method);
            if (expected.TryGetProperty("matchQuality", out var quality))
            {
                var name = quality.GetString() ?? throw new InvalidOperationException("Missing quality");
                qualities.Add(name);
                Assert.Equal(name, result.MatchQuality is MatchQuality value ? JsonNamingPolicy.KebabCaseLower.ConvertName(value.ToString()) : null);
            }
            else Assert.Null(result.MatchQuality);
            Assert.Equal(expected.Deserialize<TextSpan>(AnnotationCaseOptions), result.Span);
        }
        Assert.Equal(Enum.GetNames<AnchorMethod>().Select(JsonNamingPolicy.KebabCaseLower.ConvertName).Order(), methods.Order());
        Assert.Equal(Enum.GetNames<MatchQuality>().Select(JsonNamingPolicy.KebabCaseLower.ConvertName).Order(), qualities.Order());
    }

    [Fact]
    public void PdfLocationRunsTheSharedCases()
    {
        using var table = ReadSpec("annotations/pdf-locate-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var span = row.GetProperty("span");
            var (items, rectangles) = PdfLocation.Locate(Required<AnchoredText>(row.GetProperty("anchored")),
                span.GetProperty("start").GetInt32(), span.GetProperty("end").GetInt32());
            Assert.True(JsonElement.DeepEquals(row.GetProperty("overlapping"), JsonSerializer.SerializeToElement(items)), Text(row, "why"));
            var boxes = rectangles.Select(box => new { page = box.Page, x = box.X, y = box.Y, width = box.Width, height = box.Height });
            Assert.True(JsonElement.DeepEquals(row.GetProperty("rects"), JsonSerializer.SerializeToElement(boxes)), Text(row, "why"));
            Assert.Equal(Required<string[]>(row.GetProperty("fragments")), rectangles.Select(box => box.Fragment()));
        }
    }

    [Fact]
    public void TextOffsetsRunTheSharedCasesInBothDirections()
    {
        using var table = ReadSpec("text/offset-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var text = new ScalarText(Text(row, "text"));
            Assert.Equal(row.GetProperty("codePoints").GetInt32(), text.Length);
            foreach (var span in row.GetProperty("spans").EnumerateArray())
            {
                var quote = new ScalarText(Text(span, "exact"));
                var found = text.Places(quote).ElementAt(span.GetProperty("occurrence").GetInt32() - 1);
                var start = span.GetProperty("start").GetInt32();
                var end = span.GetProperty("end").GetInt32();
                Assert.Equal(start, found);
                Assert.Equal(end, found + quote.Length);
                Assert.Equal(Text(span, "exact"), text.Slice(start, end));
            }
        }
    }
}
