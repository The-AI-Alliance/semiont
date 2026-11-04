using System.Text.Json;
using Semiont.Protocol;

namespace Semiont.SignIn;

internal static class SignInPolicy
{
    private static readonly JsonDocument OAuth = JsonDocument.Parse(ProtocolTables.OAuth);
    internal static string Scope => OAuth.RootElement.GetProperty("scope").GetProperty("value").GetString() ?? throw new InvalidOperationException("No OAuth scope");
    internal static string ScriptClientId => ClientId("script");
    private static string ClientId(string name) => OAuth.RootElement.GetProperty("clients").EnumerateArray().Single(client => client.GetProperty("name").GetString() == name).GetProperty("id").GetString() ?? throw new InvalidOperationException("No OAuth client ID");
}
