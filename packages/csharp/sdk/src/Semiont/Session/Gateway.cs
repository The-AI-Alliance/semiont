using System.Globalization;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Session;

public static class Gateway
{
    public static bool IsValidHostname(string host) => host.Split('.').All(label =>
        label.Length is >= 1 and <= 63 && char.IsAsciiLetterOrDigit(label[0]) && char.IsAsciiLetterOrDigit(label[^1]) &&
        label.All(character => char.IsAsciiLetterOrDigit(character) || character == '-'));

    public static string Origin(HttpEndpoint endpoint)
    {
        if (!IsValidHostname(endpoint.Host)) throw new SignInError(ProtocolFacts.SignInError("discovery"), "Invalid knowledge-base hostname");
        // Serialization checks the generated protocol enum and port bounds before forming an origin.
        var wire = JsonSerializer.SerializeToElement(endpoint);
        return wire.GetProperty("protocol").GetString() + "://" + endpoint.Host.ToLowerInvariant() + ":" + endpoint.Port.ToString(CultureInfo.InvariantCulture);
    }

    public static async Task<UserResponse> GetCurrentUserAsync(string origin, string token, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, CancellationToken cancellation = default)
    {
        using var transport = new HttpTransport(origin, token, [], httpClient: httpClient, timeProvider: timeProvider);
        return await transport.AnswerAsync<UserResponse>(HttpMethod.Get, "/api/users/me", cancellation: cancellation, retry: false).ConfigureAwait(Spawning.Captures);
    }
}
