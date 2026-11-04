using System.Globalization;
using System.Text;

namespace Semiont.Annotations;

public sealed record QuotedText(string Exact, string? Prefix = null, string? Suffix = null);
public sealed record TextSpan(int Start, int End, string Exact, string? Prefix = null, string? Suffix = null);
public sealed record ReconciledSpan(TextSpan Span, AnchorMethod AnchorMethod, MatchQuality? MatchQuality = null);
public enum MatchQuality { Normalized, CaseInsensitive, Fuzzy }
public enum AnchorMethod { UniqueMatch, ContextRecovered, FirstOfMany, FuzzyMatch }

internal sealed class ScalarText(Rune[] points)
{
    internal ScalarText(string text) : this(text.EnumerateRunes().ToArray()) { }

    internal Rune[] Points { get; } = points;
    internal int Length => Points.Length;

    internal string Slice(int start, int end)
    {
        var result = new StringBuilder(end - start);
        Span<char> buffer = stackalloc char[2];
        foreach (var rune in Points.AsSpan(start, end - start))
            result.Append(buffer[..rune.EncodeToUtf16(buffer)]);
        return result.ToString();
    }

    internal IEnumerable<int> Places(ScalarText exact)
    {
        if (exact.Length == 0) yield break;
        for (var at = 0; at <= Length - exact.Length; at++)
            if (Points.AsSpan(at, exact.Length).SequenceEqual(exact.Points)) yield return at;
    }

    internal bool Contains(string text) => Places(new ScalarText(text)).Any();

    internal static string Collapse(string text)
    {
        var result = new StringBuilder();
        var space = false;
        foreach (var point in text.EnumerateRunes())
        {
            if (Rune.IsWhiteSpace(point)) { space = result.Length > 0; continue; }
            if (space) result.Append(' ');
            result.Append(point.ToString());
            space = false;
        }
        return result.ToString();
    }
}

public static partial class AnnotationTools
{
    public static ReconciledSpan? Reconcile(string text, QuotedText quoted)
    {
        if (string.IsNullOrWhiteSpace(quoted.Exact)) return null;
        var whole = new ScalarText(text);
        var exact = new ScalarText(quoted.Exact);
        var places = whole.Places(exact).Select(at => (Start: at, End: at + exact.Length)).ToArray();
        if (places.Length == 1) return Reconciled(whole, places[0], AnchorMethod.UniqueMatch);
        if (places.Length > 1)
        {
            var recovered = Hinted(whole, places, quoted);
            return recovered.HasValue ? Reconciled(whole, recovered.Value, AnchorMethod.ContextRecovered) :
                Reconciled(whole, places[0], AnchorMethod.FirstOfMany);
        }
        return ChangedMatch(whole, exact, quoted, Normalize, MatchQuality.Normalized)
            ?? ChangedMatch(whole, exact, quoted, Lower, MatchQuality.CaseInsensitive)
            ?? (Nearest(whole, exact) is { } near ? Reconciled(whole, near, AnchorMethod.FuzzyMatch, MatchQuality.Fuzzy) : null);
    }

    private static ReconciledSpan? ChangedMatch(ScalarText whole, ScalarText exact, QuotedText quoted,
        Func<ScalarText, ChangedText> change, MatchQuality quality)
    {
        var transformed = change(whole);
        var wanted = change(exact).Text;
        var places = transformed.Text.Places(wanted)
            .Select(at => (Start: transformed.From[at], End: transformed.From[at + wanted.Length - 1] + 1)).ToArray();
        return places.Length == 0 ? null :
            Reconciled(whole, Hinted(whole, places, quoted) ?? places[0], AnchorMethod.FuzzyMatch, quality);
    }

    private static (int Start, int End)? Hinted(ScalarText text, (int Start, int End)[] places, QuotedText quote)
    {
        var prefix = quote.Prefix?.Trim();
        var suffix = quote.Suffix?.Trim();
        if (string.IsNullOrEmpty(prefix) && string.IsNullOrEmpty(suffix)) return null;
        var before = Math.Max(32, quote.Prefix?.EnumerateRunes().Count() ?? 0);
        var after = Math.Max(32, quote.Suffix?.EnumerateRunes().Count() ?? 0);
        foreach (var place in places)
        {
            if (!string.IsNullOrEmpty(prefix) &&
                !new ScalarText(text.Slice(Math.Max(0, place.Start - before), place.Start)).Contains(prefix)) continue;
            if (!string.IsNullOrEmpty(suffix) &&
                !new ScalarText(text.Slice(place.End, Math.Min(text.Length, place.End + after))).Contains(suffix)) continue;
            return place;
        }
        return null;
    }

    private static ReconciledSpan Reconciled(ScalarText text, (int Start, int End) place, AnchorMethod method,
        MatchQuality? quality = null)
    {
        var begin = Math.Max(0, place.Start - 64);
        var first = Math.Max(0, begin - 32);
        while (begin > first && !Boundary(text.Points[begin - 1])) begin--;
        var end = Math.Min(text.Length, place.End + 64);
        var last = Math.Min(text.Length, end + 32);
        while (end < last && !Boundary(text.Points[end])) end++;
        var span = new TextSpan(place.Start, place.End, text.Slice(place.Start, place.End),
            place.Start == 0 ? null : text.Slice(begin, place.Start),
            place.End == text.Length ? null : text.Slice(place.End, end));
        return new ReconciledSpan(span, method, quality);
    }

    private static bool Boundary(Rune point) => Rune.IsWhiteSpace(point) ||
        (point.IsAscii && ".,;:!?'\"()[]{}<>/\\".Contains((char)point.Value));

    private static ChangedText Normalize(ScalarText text)
    {
        var points = new List<Rune>();
        var from = new List<int>();
        int? whitespace = null;
        for (var offset = 0; offset < text.Length; offset++)
        {
            var point = text.Points[offset];
            if (Rune.IsWhiteSpace(point)) { whitespace ??= offset; continue; }
            if (whitespace is int space && points.Count > 0) Append(new Rune(' '), space);
            whitespace = null;
            switch (point.Value)
            {
                case 0x2018 or 0x2019: Append(new Rune('\''), offset); break;
                case 0x201c or 0x201d: Append(new Rune('"'), offset); break;
                case 0x2014: Append(new Rune('-'), offset); Append(new Rune('-'), offset); break;
                case 0x2013: Append(new Rune('-'), offset); break;
                default: Append(point, offset); break;
            }
        }
        return new ChangedText(new ScalarText(points.ToArray()), from.ToArray());

        void Append(Rune point, int offset) { points.Add(point); from.Add(offset); }
    }

    private static ChangedText Lower(ScalarText text)
    {
        var points = new List<Rune>();
        var from = new List<int>();
        for (var offset = 0; offset < text.Length; offset++)
        {
            var point = text.Points[offset];
            if (point.Value == 0x130)
            {
                points.Add(new Rune('i'));
                from.Add(offset);
                point = new Rune(0x307);
            }
            else if (point.Value == 0x3a3 && CasedNeighbor(text, offset, -1) && !CasedNeighbor(text, offset, 1))
            {
                point = new Rune(0x3c2);
            }
            points.Add(Rune.ToLowerInvariant(point));
            from.Add(offset);
        }
        return new ChangedText(new ScalarText(points.ToArray()), from.ToArray());
    }

    private static bool CasedNeighbor(ScalarText text, int offset, int step)
    {
        for (var at = offset + step; at >= 0 && at < text.Length; at += step)
        {
            var point = text.Points[at];
            var category = Rune.GetUnicodeCategory(point);
            if (category is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark or UnicodeCategory.Format
                or UnicodeCategory.ModifierLetter or UnicodeCategory.ModifierSymbol || point.Value is 0x27 or 0x2019) continue;
            return category is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter;
        }
        return false;
    }

    private static (int Start, int End)? Nearest(ScalarText text, ScalarText exact)
    {
        var allowance = exact.Length / 20;
        var shortest = exact.Length - allowance;
        if (allowance == 0 || text.Length < shortest) return null;
        var beyond = allowance + 1;
        var bestDistance = beyond;
        (int Start, int End)? best = null;
        var width = 2 * allowance + 3;
        var row = new int[width];
        var above = new int[width];
        for (var start = 0; start <= text.Length - shortest; start++)
        {
            var longest = Math.Min(exact.Length + allowance, text.Length - start);
            Array.Fill(row, beyond);
            for (var length = 0; length <= allowance; length++) row[length + allowance + 1] = length;
            var refused = false;
            for (var taken = 1; taken <= exact.Length; taken++)
            {
                (row, above) = (above, row);
                Array.Fill(row, beyond);
                var least = beyond;
                for (var length = Math.Max(0, taken - allowance); length <= Math.Min(longest, taken + allowance); length++)
                {
                    var at = length - taken + allowance + 1;
                    var replacement = length > 0 && exact.Points[taken - 1] != text.Points[start + length - 1] ? 1 : 0;
                    var distance = length == 0 ? taken : Math.Min(above[at + 1] + 1, Math.Min(row[at - 1] + 1, above[at] + replacement));
                    row[at] = Math.Min(distance, beyond);
                    least = Math.Min(least, distance);
                }
                if (least <= allowance) continue;
                refused = true;
                break;
            }
            if (refused) continue;
            TryLength(exact.Length);
            for (var offset = 1; offset <= allowance; offset++)
            {
                TryLength(exact.Length - offset);
                TryLength(exact.Length + offset);
            }
            if (bestDistance == 0) break;

            void TryLength(int length)
            {
                if (length > longest) return;
                var distance = row[length - exact.Length + allowance + 1];
                if (distance >= bestDistance) return;
                bestDistance = distance;
                best = (start, start + length);
            }
        }
        return best;
    }

    private sealed record ChangedText(ScalarText Text, int[] From);
}
