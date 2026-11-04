using System.Text;
using System.Text.Json;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

internal static class MediaTypes
{
    private const string PlainText = "text/plain";
    private static readonly JsonDocument Registry = JsonDocument.Parse(ProtocolTables.MediaTypes);
    private static readonly Dictionary<string, JsonElement> Rows = Registry.RootElement.GetProperty("mediaTypes")
        .EnumerateArray().ToDictionary(row => Text(row, "mediaType"), StringComparer.Ordinal);

    internal static string Base(string format) => format.AsSpan().SplitAtSemicolon().Trim().ToString().ToLowerInvariant();

    internal static string TextSource(string format)
    {
        var media = Base(format);
        return Rows.TryGetValue(media, out var row) ? Text(row, "textSource") :
            media.StartsWith("text/", StringComparison.Ordinal) ? "decode" : "none";
    }

    internal static string? Primary(ResourceDescriptor descriptor) => descriptor.Representations switch
    {
        ResourceDescriptorRepresentations.RepresentationCase(var primary) => primary.MediaType,
        ResourceDescriptorRepresentations.ArrayCase(var representations) => representations.FirstOrDefault()?.MediaType,
    };

    internal static string CloneFormat(string? format)
    {
        var media = format is null ? PlainText : Base(format);
        return Rows.TryGetValue(media, out var row) && row.GetProperty("authorable").GetBoolean() ? media : PlainText;
    }

    internal static string StorageFileName(string name, string format)
    {
        var slug = new StringBuilder();
        var separated = true;
        foreach (var character in name.ToLowerInvariant())
        {
            if (char.IsAsciiLetterOrDigit(character))
            {
                if (separated && slug.Length > 0) slug.Append('-');
                slug.Append(character);
                separated = false;
            }
            else separated = true;
        }
        var extension = Rows.TryGetValue(Base(format), out var row) ? Text(row, "extension") : ".dat";
        return slug.Append(extension).ToString();
    }

    internal static ReadOnlySpan<char> SplitAtSemicolon(this ReadOnlySpan<char> value)
    {
        var end = value.IndexOf(';');
        return end < 0 ? value : value[..end];
    }

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing media type member " + name);
}
