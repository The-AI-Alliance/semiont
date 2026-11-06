using System.Text.Json;
using Semiont.Types;
using Xunit;
using static Semiont.Resources.ResourceReaders;
using static Semiont.Serialization.Required;

namespace Semiont.Tests;

// The readers of a resource's description, held to protocol/specs/src/resources/reader-cases.json, the table
// every SDK's readers run. Each resource is held to the table of what its schema requires before it is decoded:
// a refused case is refused there, for the fault it states, and its decoder refuses it too.
public sealed partial class TransportTests
{
    private static readonly string[] ResourceReadMembers = ["why", "resource", "entityTypes", "primaryRepresentation", "primaryMediaType"];
    private static readonly string[] ResourceRefusedMembers = ["why", "resource", "refused", "member", "reason"];

    [Fact]
    public void ResourceReadersRunTheSharedCases()
    {
        using var table = ReadSpec("resources/reader-cases.json");
        var (one, several, none) = (0, 0, 0);
        var reasons = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var why = Text(row, "why");
            var resource = row.GetProperty("resource");
            var members = row.EnumerateObject().Select(member => member.Name).ToArray();
            if (row.TryGetProperty("refused", out var refused))
            {
                Assert.True(refused.GetBoolean(), why);
                Assert.True(members.Order(StringComparer.Ordinal).SequenceEqual(ResourceRefusedMembers.Order(StringComparer.Ordinal)), why);
                var fault = FaultOf("ResourceDescriptor", resource);
                Assert.NotNull(fault);
                Assert.True(fault.Member == Text(row, "member"), why + ": the fault is at " + fault.Member);
                Assert.True(fault.Reason.ToString().ToLowerInvariant() == Text(row, "reason"), why + ": the fault " + fault.Reason);
                reasons.Add(Text(row, "reason"));
                Assert.Throws<JsonException>(() => resource.Deserialize<ResourceDescriptor>());
                continue;
            }
            Assert.True(members.All(member => ResourceReadMembers.Contains(member, StringComparer.Ordinal)), why);
            Assert.Null(FaultOf("ResourceDescriptor", resource));
            var descriptor = Required<ResourceDescriptor>(resource);
            switch (descriptor.Representations)
            {
                case ResourceDescriptorRepresentations.RepresentationCase: one++; break;
                case ResourceDescriptorRepresentations.ArrayCase(var listed) when listed.Count == 0: none++; break;
                case ResourceDescriptorRepresentations.ArrayCase: several++; break;
            }
            var primary = PrimaryRepresentation(descriptor);
            Assert.True(row.TryGetProperty("primaryRepresentation", out var representation)
                ? primary is not null && JsonElement.DeepEquals(representation, JsonSerializer.SerializeToElement(primary))
                : primary is null, why + ": the primary representation");
            var mediaType = PrimaryMediaType(descriptor);
            Assert.True(row.TryGetProperty("primaryMediaType", out var stated) ? stated.GetString() == mediaType : mediaType is null,
                why + ": the primary media type is " + mediaType);
            Assert.True(JsonElement.DeepEquals(row.GetProperty("entityTypes"), JsonSerializer.SerializeToElement(ResourceEntityTypes(descriptor))),
                why + ": the entity types");
        }
        Assert.True(one > 0 && several > 0 && none > 0);
        Assert.True(reasons.SetEquals(["lacks", "malformed"]), string.Join(", ", reasons));
    }
}
