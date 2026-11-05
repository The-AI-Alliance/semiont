using System.Text;
using System.Text.Json;
using Semiont.Protocol;

namespace Semiont.Session;

public static class Tokens
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private static JsonElement? Claims(string token)
    {
        var segments = token.Split('.');
        if (segments.Length != 3) return null;
        try
        {
            var encoded = segments[1].Replace('-', '+').Replace('_', '/');
            var bytes = Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '='));
            using var document = JsonDocument.Parse(Utf8.GetString(bytes));
            return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.Clone() : null;
        }
        catch (Exception error) when (error is FormatException || error is JsonException || error is DecoderFallbackException) { return null; }
    }

    public static string? TextClaim(string token, string name) => Claims(token) is JsonElement claims && claims.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    public static double? TokenExpiry(string token) => Claims(token) is JsonElement claims ? Seconds(claims, "exp") : null;

    private static double? Seconds(JsonElement claims, string name) => claims.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var seconds) && seconds != 0 && double.IsFinite(seconds) ? seconds : null;

    public static bool IsTokenExpired(string token, double now) => TokenExpiry(token) is not double expiry || expiry <= now;

    public static double RenewalDelay(double lifetime, double remaining) => Math.Max(
        remaining - Math.Min(ProtocolFacts.Timing("refreshBeforeExpMs").GetDouble() / 1000, lifetime / 2),
        ProtocolFacts.Timing("minRefreshDelayMs").GetDouble() / 1000);

    public static double? RefreshDelay(string token, double now)
    {
        var claims = Claims(token);
        if (claims is not JsonElement read || Seconds(read, "exp") is not double expiry) return null;
        var remaining = Math.Max(expiry - now, 0);
        var issued = Seconds(read, "iat");
        return RenewalDelay(issued is double iat ? Math.Max(expiry - iat, 0) : remaining, remaining);
    }
}
