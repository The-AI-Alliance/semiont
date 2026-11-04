using System.Net;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Fact]
    public async Task BrowseTextRunsTheSharedDecodingCases()
    {
        using var cases = ReadSpec("text/decode-cases.json");
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var resource = ResourceId.Parse("res-1");
        foreach (var row in cases.RootElement.GetProperty("cases").EnumerateArray())
        {
            var type = Text(row, "contentType");
            server.Other = (_, _) =>
            {
                var content = new ByteArrayContent(Bytes(Text(row, "bytes")));
                Assert.True(content.Headers.TryAddWithoutValidation("Content-Type", type));
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            };
            if (row.TryGetProperty("refused", out var refused))
            {
                var error = await Assert.ThrowsAsync<TransportError>(() => client.Browse.ResourceContentAsync(resource, deadline.Token));
                Assert.Contains(refused.GetString() ?? throw new InvalidOperationException("Missing refusal"), error.Message);
            }
            else
            {
                Assert.Equal(Text(row, "text"), await client.Browse.ResourceContentAsync(resource, deadline.Token));
            }
        }
    }

    [Fact]
    public void ResourceTextDecodesEveryLabelAndSingleByteMapping()
    {
        using var cases = ReadSpec("text/encoding-cases.json");
        foreach (var row in cases.RootElement.GetProperty("cases").EnumerateArray())
        {
            var everyByte = row.TryGetProperty("everyByte", out var map);
            var refused = row.TryGetProperty("refused", out var marker) && marker.GetBoolean();
            var bytes = refused ? [] : everyByte ? Enumerable.Range(0, 256).Select(value => (byte)value).ToArray() : Bytes(Text(row, "bytes"));
            var expected = refused ? null : everyByte ? map.GetString() : Text(row, "text");
            foreach (var value in row.GetProperty("labels").EnumerateArray())
            {
                var label = (value.GetString() ?? throw new InvalidOperationException("Missing label")).ToUpperInvariant();
                var type = "text/plain; charset=\" " + label + "\t\"";
                if (refused)
                {
                    var error = Assert.Throws<TransportError>(() => RepresentationText.Decode(bytes, type));
                    Assert.Contains(label, error.Message);
                }
                else
                {
                    Assert.Equal(expected, RepresentationText.Decode(bytes, type));
                }
            }
        }
    }

    [Fact]
    public void ContentPolicyRunsTheSharedMediaTypeCases()
    {
        using var cases = ReadSpec("media-types/cases.json");
        foreach (var row in cases.RootElement.GetProperty("cloneFormat").EnumerateArray())
            Assert.Equal(Text(row, "format"), MediaTypes.CloneFormat(row.GetProperty("source").GetString()));
        foreach (var row in cases.RootElement.GetProperty("storageFileName").EnumerateArray())
            Assert.Equal(Text(row, "fileName"), MediaTypes.StorageFileName(Text(row, "name"), Text(row, "format")));
        foreach (var row in cases.RootElement.GetProperty("textSource").EnumerateArray())
        {
            var source = MediaTypes.TextSource(Text(row, "format"));
            Assert.Equal(Text(row, "textSource"), source);
            Assert.Equal(row.GetProperty("derivesText").GetBoolean(), source == "pdf-text-layer");
            Assert.Equal(row.GetProperty("yieldsGeometry").GetBoolean(), source == "pdf-text-layer");
        }
    }

    private static JsonDocument ReadSpec(string file) =>
        JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs", file)));

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);

    private static byte[] Bytes(string hex) => Convert.FromHexString(hex.Replace(" ", "", StringComparison.Ordinal));
}
