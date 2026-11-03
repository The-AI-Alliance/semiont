using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Http;
using Xunit;

namespace Semiont.Tests;

public sealed class BusLogTests
{
    [Fact]
    public void EverySharedPayloadWithholdsExactlyTheDeclaredMembers()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/bus/log-cases.json")));
        foreach (var test in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var payload = JsonNode.Parse(test.GetProperty("payload").GetRawText());
            var before = payload?.DeepClone();
            var shown = BusLog.Shown(payload);
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(test.GetProperty("shown").GetRawText()), shown), test.GetProperty("why").GetString());
            Assert.True(JsonNode.DeepEquals(before, payload));
        }
    }

    [Theory]
    [InlineData("null", "null")]
    [InlineData("42", "42")]
    [InlineData("\"token\"", "\"token\"")]
    [InlineData("[{\"password\":null},\"token\"]", "[{\"password\":\"[withheld]\"},\"token\"]")]
    public void OtherJsonValuesFollowTheSameRule(string payload, string shown) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(shown), BusLog.Shown(JsonNode.Parse(payload))));
}
