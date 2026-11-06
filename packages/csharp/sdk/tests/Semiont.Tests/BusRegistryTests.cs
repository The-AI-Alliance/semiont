using System.Text.Json;
using Xunit;

namespace Semiont.Tests;

/// <summary>What the bus's registry gives beside its channels, held to protocol/specs/src/bus/registry.json.</summary>
public sealed class BusRegistryTests
{
    private static readonly JsonElement Registry = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/bus/registry.json")));

    private static string Text(JsonElement row, string name) => row.GetProperty(name).GetString() ?? throw new InvalidOperationException("The registry states no " + name);

    private static JsonElement[] Operations() => Registry.GetProperty("operations").EnumerateArray().ToArray();

    [Fact]
    public void EachOperationsRepliesAreItsResultAndItsFailure()
    {
        var operations = Operations();
        Assert.NotEmpty(operations);
        foreach (var operation in operations)
            Assert.Equal([Text(operation, "result"), Text(operation, "failure")], BusRegistry.ReplyChannelsFor(Text(operation, "request")));
    }

    [Fact]
    public void RepliesAreNamedOnceInTheOrderAskedAndAChannelThatIsNoRequestHasNone()
    {
        var operations = Operations();
        var (first, second) = (operations[0], operations[1]);
        var requests = operations.Select(operation => Text(operation, "request")).ToHashSet(StringComparer.Ordinal);
        var unasked = Registry.GetProperty("channels").EnumerateArray().Select(row => Text(row, "channel")).First(channel => !requests.Contains(channel));
        Assert.Equal([Text(first, "result"), Text(first, "failure"), Text(second, "result"), Text(second, "failure")],
            BusRegistry.ReplyChannelsFor(Text(first, "request"), Text(second, "request"), Text(first, "request"), unasked));
        Assert.Empty(BusRegistry.ReplyChannelsFor(unasked));
    }

    [Fact]
    public void TheEventsOfTheRecordAreTheRegistrysInItsOrder()
    {
        var ofTheRecord = Registry.GetProperty("channels").EnumerateArray().Where(row => row.TryGetProperty("event", out _)).Select(row => Text(row, "channel")).ToArray();
        Assert.NotEmpty(ofTheRecord);
        Assert.Equal(ofTheRecord, BusRegistry.PersistedEventTypes);
    }

    [Fact]
    public void ARequestWhoseRepliesCannotArriveIsRefusedAsTheConformanceCaseSays()
    {
        using var held = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "corpus/sdk/wire/request-unsubscribed.json")));
        var fails = held.RootElement.GetProperty("steps").EnumerateArray().Single(step => step.TryGetProperty("fails", out _)).GetProperty("fails");
        var reply = Text(Operations()[0], "result");
        var refusal = BusRegistry.Unsubscribed(reply);
        Assert.Equal(Text(fails, "code"), refusal.Code);
        Assert.Contains(reply, refusal.Message, StringComparison.Ordinal);
    }
}
