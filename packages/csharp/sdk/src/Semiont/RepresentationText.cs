using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;

namespace Semiont;

internal static class RepresentationText
{
    private const string HttpWhitespace = "\t\n\r ";
    private const string EncodingWhitespace = HttpWhitespace + "\f";
    private static readonly byte[] Utf16LeMark = [0xff, 0xfe];
    private static readonly byte[] Utf16BeMark = [0xfe, 0xff];
    private static readonly JsonDocument Table = JsonDocument.Parse(ProtocolTables.Encodings);
    private static readonly Dictionary<string, Decoder> Decoders = MakeDecoders();

    internal static string Decode(ReadOnlySpan<byte> bytes, string contentType)
    {
        if (MediaTypes.TextSource(contentType) != "decode")
            throw Refusal("The resource's media type does not supply decoded text: " + MediaTypes.Base(contentType));

        var label = Charset(contentType).AsSpan().Trim(EncodingWhitespace).ToString();
        if (label.Length == 0) label = "utf-8";
        if (!label.All(char.IsAscii) || !Decoders.TryGetValue(label, out var decoder) || decoder.Refused)
            throw Refusal("Unsupported resource charset: " + label);

        if (bytes.StartsWith(Encoding.UTF8.Preamble)) return Encoding.UTF8.GetString(bytes[3..]);
        if (bytes.StartsWith(Utf16LeMark)) return Utf16(bytes[2..], bigEndian: false);
        if (bytes.StartsWith(Utf16BeMark)) return Utf16(bytes[2..], bigEndian: true);

        return decoder.Name switch
        {
            "utf-8" => Encoding.UTF8.GetString(bytes),
            "utf-16le" => Utf16(bytes, bigEndian: false),
            "utf-16be" => Utf16(bytes, bigEndian: true),
            _ when decoder.SingleByte is { } map => SingleByte(bytes, map),
            _ => Legacy(decoder.Name).GetString(bytes),
        };
    }

    private static string Utf16(ReadOnlySpan<byte> bytes, bool bigEndian)
    {
        if (bytes.Length >= 3 && bytes.Length % 2 != 0)
        {
            var pair = bytes[^3..^1];
            var last = bigEndian ? BinaryPrimitives.ReadUInt16BigEndian(pair) : BinaryPrimitives.ReadUInt16LittleEndian(pair);
            // The unmatched high surrogate and a trailing byte form one decoder error.
            if (last is >= 0xd800 and <= 0xdbff) bytes = bytes[..^1];
        }
        return (bigEndian ? Encoding.BigEndianUnicode : Encoding.Unicode).GetString(bytes);
    }

    private static string SingleByte(ReadOnlySpan<byte> bytes, string[] map)
    {
        var text = new StringBuilder(bytes.Length);
        foreach (var value in bytes) text.Append(map[value]);
        return text.ToString();
    }

    // The shared table owns labels and single-byte mappings. These IDs select platform decoders.
    private static Encoding Legacy(string name)
    {
        var codePage = name switch
        {
            "big5" => 950,
            "euc-jp" => 51932,
            "euc-kr" => 949,
            "gb18030" => 54936,
            "gbk" => 54936,
            "iso-2022-jp" => 50220,
            "shift_jis" => 932,
            _ => throw Refusal("Unsupported resource charset: " + name),
        };
        return CodePagesEncodingProvider.Instance.GetEncoding(codePage, EncoderFallback.ReplacementFallback, new DecoderReplacementFallback("�"))
            ?? throw Refusal("Unsupported resource charset: " + name);
    }

    private static Dictionary<string, Decoder> MakeDecoders()
    {
        var labels = new Dictionary<string, Decoder>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in Table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var name = Required(row.GetProperty("encoding"));
            var map = row.TryGetProperty("everyByte", out var text)
                ? Required(text).EnumerateRunes().Select(rune => rune.ToString()).ToArray() : null;
            if (map is { Length: not 256 }) throw new InvalidOperationException("Incomplete single-byte mapping for " + name);
            var refused = row.TryGetProperty("refused", out var marker) && marker.GetBoolean();
            var decoder = new Decoder(name, map, refused);
            foreach (var label in row.GetProperty("labels").EnumerateArray()) labels.Add(Required(label), decoder);
        }
        return labels;
    }

    private static string? Charset(string header)
    {
        var value = header.AsSpan().Trim(HttpWhitespace);
        var type = value.SplitAtSemicolon();
        var slash = type.IndexOf('/');
        if (slash < 0 || !IsToken(type[..slash]) || !IsToken(type[(slash + 1)..].TrimEnd(HttpWhitespace))) return null;

        var remaining = value[type.Length..];
        while (!remaining.IsEmpty)
        {
            remaining = remaining[1..].TrimStart(HttpWhitespace);
            var nameEnd = remaining.IndexOfAny('=', ';');
            if (nameEnd < 0) break;
            var name = remaining[..nameEnd];
            if (remaining[nameEnd] == ';')
            {
                remaining = remaining[nameEnd..];
                continue;
            }

            remaining = remaining[(nameEnd + 1)..];
            string parameter;
            if (!remaining.IsEmpty && remaining[0] == '"')
            {
                parameter = ReadQuoted(ref remaining);
            }
            else
            {
                var raw = remaining.SplitAtSemicolon();
                remaining = remaining[raw.Length..];
                parameter = raw.TrimEnd(HttpWhitespace).ToString();
                if (parameter.Length == 0) continue;
            }
            if (name.Equals("charset", StringComparison.OrdinalIgnoreCase) && parameter.All(IsParameterCharacter))
                return parameter;
        }
        return null;
    }

    private static string ReadQuoted(ref ReadOnlySpan<char> remaining)
    {
        var value = new StringBuilder();
        var index = 1;
        while (index < remaining.Length)
        {
            var character = remaining[index++];
            if (character == '"') break;
            if (character == '\\' && index < remaining.Length) character = remaining[index++];
            value.Append(character);
        }
        var delimiter = remaining[index..].IndexOf(';');
        remaining = delimiter < 0 ? [] : remaining[(index + delimiter)..];
        return value.ToString();
    }

    private static bool IsToken(ReadOnlySpan<char> value)
    {
        if (value.IsEmpty) return false;
        foreach (var character in value)
            if (!char.IsAsciiLetterOrDigit(character) && !"!#$%&'*+-.^`_|~".Contains(character)) return false;
        return true;
    }

    private static bool IsParameterCharacter(char value) =>
        value is '\t' or (>= (char)32 and <= (char)126) or (>= (char)128 and <= (char)255);

    private static string Required(JsonElement value) => value.GetString() ?? throw new InvalidOperationException("Missing encoding label.");
    private static TransportError Refusal(string message) => new(ProtocolFacts.Error(0), message);
    private sealed record Decoder(string Name, string[]? SingleByte, bool Refused);
}
