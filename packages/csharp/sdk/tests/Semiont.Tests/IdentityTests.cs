using System.Text.Json;
using Semiont.Session;
using Xunit;

namespace Semiont.Tests;

public sealed class IdentityTests
{
    [Fact]
    public void EveryDeclaredKnowledgeBaseDomainProducesItsDidAndResource()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/kb-identity/cases.json")));
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            if (row.GetProperty("domain").GetString() is not string domain) continue;
            Assert.Equal(row.GetProperty("did").GetString(), Identity.KbDid(domain).ToString());
            Assert.Equal(row.GetProperty("resource").GetString(), Identity.KbResource(domain));
        }
    }

    [Theory]
    [InlineData("people")]
    [InlineData("agents")]
    public void EveryPrincipalCaseRuns(string group)
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/principals/cases.json")));
        foreach (var row in table.RootElement.GetProperty(group).EnumerateArray())
        {
            var domain = row.GetProperty("domain").GetString() ?? throw new InvalidOperationException("Missing domain");
            var subject = row.GetProperty("subject").GetString() ?? throw new InvalidOperationException("Missing subject");
            var did = group == "people" ? Identity.PersonDid(domain, subject) : Identity.AgentDid(domain, subject);
            Assert.Equal(row.GetProperty("did").GetString(), did.ToString());
        }
    }
}
