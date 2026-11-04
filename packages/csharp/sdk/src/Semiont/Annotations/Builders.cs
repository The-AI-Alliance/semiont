using System.Globalization;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Annotations;

public sealed class SpanRefusedError : SemiontError
{
    internal SpanRefusedError(string code) : base(code, code) { }
}

public closed record Spanned
{
    public sealed record Text(string Value) : Spanned;
    public sealed record Anchored(AnchoredText Value) : Spanned;
}

public sealed record OfSpan(ResourceId ResourceId, Motivation Motivation, Agent Generator, TextSpan Span, Spanned Text,
    AnnotationBodies? Body = null);
public sealed record OfResource(ResourceId ResourceId, Motivation Motivation, Agent? Generator = null, AnnotationBodies? Body = null);

public static partial class AnnotationTools
{
    public static Annotation AnnotationOfSpan(OfSpan input)
    {
        var anchored = input.Text is Spanned.Anchored(var pdf) ? pdf : null;
        var source = input.Text switch
        {
            Spanned.Anchored(var value) => value.Text,
            Spanned.Text(var value) => value,
        };
        var text = new ScalarText(source);
        if (anchored is not null && anchored.Items.Any(item => !ValidSpan(item.Start, item.End, text.Length)))
            throw Refused("item-out-of-range");

        var span = input.Span;
        if (!ValidSpan(span.Start, span.End, text.Length)) throw Refused("span-out-of-range");
        var selectors = anchored is null ? TextSelectors(text, span) : PdfSelectors(text, anchored, span);
        if (span.Prefix is string prefix && !text.Slice(0, span.Start).EndsWith(prefix, StringComparison.Ordinal))
            throw Refused("prefix-mismatch");
        if (span.Suffix is string suffix && !text.Slice(span.End, text.Length).StartsWith(suffix, StringComparison.Ordinal))
            throw Refused("suffix-mismatch");
        selectors.Add(new Selector.TextQuoteSelectorCase(new TextQuoteSelector
        {
            Exact = span.Exact,
            Prefix = span.Prefix is { Length: > 0 } ? span.Prefix : null,
            Suffix = span.Suffix is { Length: > 0 } ? span.Suffix : null,
        }));
        var target = new AnnotationTarget
        {
            Source = input.ResourceId,
            Type = AnnotationTargetType.SpecificResource,
            Selector = new AnnotationSelector.ArrayCase(selectors.ToArray()),
        };
        return Build(target, input.Motivation, FormattableString.Invariant($"{span.Start}:{span.End}:{span.Exact}"),
            input.Generator, input.Body);
    }

    public static Annotation AnnotationOfResource(OfResource input) =>
        Build(new AnnotationTarget { Source = input.ResourceId }, input.Motivation, "", input.Generator, input.Body);

    private static List<Selector> TextSelectors(ScalarText text, TextSpan span)
    {
        if (!string.Equals(text.Slice(span.Start, span.End), span.Exact, StringComparison.Ordinal))
            throw Refused("exact-mismatch");
        return [new Selector.TextPositionSelectorCase(new TextPositionSelector { Start = span.Start, End = span.End })];
    }

    private static List<Selector> PdfSelectors(ScalarText text, AnchoredText anchored, TextSpan span)
    {
        var (items, rectangles) = PdfLocation.Locate(anchored, span.Start, span.End);
        if (rectangles.Count == 0) throw Refused("nothing-located");
        var covered = text.Slice(checked((int)items.Min(item => item.Start)), checked((int)items.Max(item => item.End)));
        var words = ScalarText.Collapse(span.Exact);
        if (words.Length == 0 || !ScalarText.Collapse(covered).Contains(words, StringComparison.Ordinal))
            throw Refused("exact-not-covered");
        return rectangles.Select(rectangle => (Selector)new Selector.FragmentSelectorCase(new FragmentSelector
        {
            ConformsTo = "http://tools.ietf.org/rfc/rfc3778",
            Value = rectangle.Fragment(),
        })).ToList();
    }

    private static Annotation Build(AnnotationTarget target, Motivation motivation, string anchor, Agent? generator, AnnotationBodies? body) =>
        new()
        {
            Id = AnnotationIdentity.Derive(target.Source, motivation, anchor, body is null ? null : JsonSerializer.SerializeToElement(body)),
            Created = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            Target = new AnnotationTargetValue.AnnotationTargetCase(target),
            Motivation = motivation,
            Generator = generator is null ? null : new AnnotationGenerator.AgentCase(generator),
            Body = body,
        };

    private static bool ValidSpan(long start, long end, int length) => start >= 0 && start <= end && end <= length;

    private static SpanRefusedError Refused(string name) => new(ProtocolFacts.SpanRefusal(name));
}
