using System.Text.Json;
using Semiont.Identifiers;
using Semiont.Protocol;

namespace Semiont.Session;

public static class Identity
{
    private static readonly JsonElement Principals = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Principals);

    public static UserId KbDid(string domain) => UserId.Parse("did:web:" + domain);

    public static string KbResource(string domain) => "https://" + domain.Replace(':', '/');

    public static UserId PersonDid(string domain, string subject) => PrincipalDid("person", domain, subject);

    public static UserId AgentDid(string domain, string subject) => PrincipalDid("agent", domain, subject);

    private static UserId PrincipalDid(string kind, string domain, string subject)
    {
        var pattern = Principals.GetProperty(kind).GetString() ?? throw new InvalidOperationException("Missing principal DID pattern");
        var escaped = Uri.EscapeDataString(subject)
            .Replace("%21", "!", StringComparison.Ordinal)
            .Replace("%27", "'", StringComparison.Ordinal)
            .Replace("%28", "(", StringComparison.Ordinal)
            .Replace("%29", ")", StringComparison.Ordinal)
            .Replace("%2A", "*", StringComparison.Ordinal);
        return UserId.Parse(pattern.Replace("{subject}", escaped, StringComparison.Ordinal)
            .Replace("{domain}", domain, StringComparison.Ordinal));
    }
}
