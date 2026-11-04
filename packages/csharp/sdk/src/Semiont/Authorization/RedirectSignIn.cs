using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Storage;
using Semiont.Types;

namespace Semiont.Authorization;

public sealed record AuthorizationIssuer(
    [property: JsonRequired] string Issuer, [property: JsonRequired] string Authorization,
    [property: JsonRequired] string Token, string? Device = null, string? Revocation = null);

public sealed record PendingAuthorization(
    [property: JsonRequired] string State, [property: JsonRequired] string Verifier, [property: JsonRequired] string RedirectUri,
    [property: JsonRequired] HttpEndpoint Target, [property: JsonRequired] AuthorizationIssuer Issuer,
    string? KbId = null, string? ExpectedDid = null, string? ExpectedName = null);

public sealed record BeginAuthorizationOptions(HttpEndpoint Target, string RedirectUri, string? KbId = null,
    string? ExpectedDid = null, string? ExpectedName = null);

public sealed record ConnectionIdentity(UserId Did, KbDescription Description);

public sealed class IdentityUnverifiableError : SemiontError
{
    internal IdentityUnverifiableError(string reason, string message, Exception? cause = null)
        : base(reason, message, inner: cause) { }
}

public static class RedirectSignIn
{
    public static readonly string PendingAuthorizationKey = RegistryStorage.PendingKey;
    public static string CodeChallenge(string verifier) => Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(verifier)));

    public static async Task<string> BeginAuthorizationAsync(BeginAuthorizationOptions options, ISessionStorage storage,
        HttpClient? httpClient = null, CancellationToken cancellation = default)
    {
        RequireHttpAddress(options.RedirectUri);
        using var issuer = new Issuer(httpClient);
        var found = await issuer.DiscoverAsync(options.Target, cancellation).ConfigureAwait(false);
        var record = new PendingAuthorization(Base64Url(RandomNumberGenerator.GetBytes(24)), Base64Url(RandomNumberGenerator.GetBytes(48)),
            options.RedirectUri, options.Target, new AuthorizationIssuer(found.Issuer, found.Authorization, found.Token, found.Device, found.Revocation),
            options.KbId, options.ExpectedDid, options.ExpectedName);
        var destination = new UriBuilder(RequireHttpAddress(found.Authorization));
        var query = new Dictionary<string, string>
        {
            ["response_type"] = "code",
            ["client_id"] = SignInPolicy.BrowserClientId,
            ["redirect_uri"] = record.RedirectUri,
            ["scope"] = SignInPolicy.Scope,
            ["state"] = record.State,
            ["code_challenge"] = CodeChallenge(record.Verifier),
            ["code_challenge_method"] = "S256",
        };
        var existing = destination.Query.TrimStart('?');
        if (ParseQuery(existing).Any(pair => query.ContainsKey(pair.Key)))
            throw Refused("discovery", "The issuer's authorization endpoint already names a grant parameter.");
        destination.Query = string.Join("&", (existing.Length == 0 ? Array.Empty<string>() : [existing])
            .Concat(query.Select(pair => pair.Key + "=" + Uri.EscapeDataString(pair.Value))));
        cancellation.ThrowIfCancellationRequested();
        storage.Set(PendingAuthorizationKey, RegistryStorage.Write(record));
        return destination.Uri.AbsoluteUri;
    }

    public static async Task<(PendingAuthorization Pending, StoredSession Session)> CompleteAuthorizationAsync(
        string callbackUrl, ISessionStorage storage, HttpClient? httpClient = null, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        string? stored = null;
        storage.Update(PendingAuthorizationKey, value => { stored = value; return null; });
        var record = RegistryStorage.Read<PendingAuthorization>(stored);
        if (record is null || string.IsNullOrEmpty(record.State) || string.IsNullOrEmpty(record.Verifier) ||
            record.Target is null || record.Issuer is null)
            throw Refused("no-pending", "No sign-in is pending here.");
        var callback = RequireHttpAddress(callbackUrl);
        var redirect = RequireHttpAddress(record.RedirectUri);
        if (callback.GetLeftPart(UriPartial.Path) != redirect.GetLeftPart(UriPartial.Path))
            throw Refused("state", "The response arrived at a different redirect address.");
        var query = ParseQuery(callback.Query.TrimStart('?')).ToLookup(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        string? One(string name) => query[name].Take(2).ToArray() is [var only] ? only : null;
        if (One("state") != record.State) throw Refused("state", "The response does not belong to the pending sign-in.");
        if (One("error") is { } error) throw Refused(error == "access_denied" ? "denied" : "exchange", "The issuer refused the sign-in.");
        if (One("code") is not { Length: > 0 } code) throw Refused("exchange", "The response has no authorization code.");
        RequireHttpAddress(record.Issuer.Token);

        using var issuer = new Issuer(httpClient);
        var answer = await issuer.AnswerAsync(record.Issuer.Token, new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = record.RedirectUri,
            ["client_id"] = SignInPolicy.BrowserClientId,
            ["code_verifier"] = record.Verifier,
        }, cancellation: cancellation).ConfigureAwait(false);
        if (answer.Status != 200 || answer.Text("access_token") is not { Length: > 0 } access ||
            answer.Text("refresh_token") is not { Length: > 0 } refresh)
            throw Refused("exchange", "The issuer did not return both tokens.", answer.Status);
        return (record, new StoredSession
        {
            Access = access,
            Refresh = refresh,
            ClientId = SignInPolicy.BrowserClientId,
            TokenEndpoint = record.Issuer.Token,
            RevocationEndpoint = record.Issuer.Revocation,
        });
    }

    public static async Task<ConnectionIdentity> DescribeConnectionAsync(HttpEndpoint target, string access,
        HttpClient? httpClient = null, CancellationToken cancellation = default)
    {
        KbDescription description;
        try
        {
            var operation = BusOperations.BrowseKbRequested;
            using var client = new SemiontClient(new HttpTransport(Gateway.Origin(target), access,
                [operation.Result.Name, operation.Failure.Name], httpClient: httpClient));
            description = await client.Browse.KbAsync(cancellation).ConfigureAwait(false);
        }
        catch (Exception error) when (error is SemiontError or JsonException)
        {
            var reason = error is BusRequestError rejected && rejected.Code == ProtocolFacts.BusError("rejected") ? "not-reported" : "unreachable";
            throw new IdentityUnverifiableError(reason, error.Message, error);
        }
        try { return new ConnectionIdentity(Identity.KbDid(description.Domain), description); }
        catch (FormatException error) { throw new IdentityUnverifiableError("not-reported", error.Message, error); }
    }

    private static Uri RequireHttpAddress(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http" &&
        string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Fragment)
        ? uri : throw Refused("exchange", "The sign-in requires a valid HTTP address.");

    private static IEnumerable<KeyValuePair<string, string>> ParseQuery(string query)
    {
        foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            yield return new(WebUtility.UrlDecode(pair[0]), pair.Length == 2 ? WebUtility.UrlDecode(pair[1]) : "");
        }
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static SignInError Refused(string name, string message, int? status = null) => new(ProtocolFacts.SignInError(name), message, status);
}
