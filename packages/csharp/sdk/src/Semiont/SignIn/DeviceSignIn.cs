using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.Types;

namespace Semiont.SignIn;

public sealed record DeviceCode(string UserCode, string VerificationUri, string? VerificationUriComplete, double ExpiresIn);

public sealed partial class Issuer
{
    internal sealed record Endpoints(string Issuer, string Authorization, string Token, string? Device, string? Revocation);

    private static string DiscoveryAddress(string address, int? status = null)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || string.IsNullOrEmpty(uri.Host))
            throw new SignInError(ProtocolFacts.SignInError("discovery"), "The issuer named an invalid HTTP address", status);
        return address;
    }

    internal async Task<Endpoints> ConfigurationAsync(string issuer, CancellationToken cancellation)
    {
        var answer = await AnswerAsync(DiscoveryAddress(issuer).TrimEnd('/') + "/.well-known/openid-configuration", errorCode: "discovery", cancellation: cancellation).ConfigureAwait(false);
        if (answer.Status is < 200 or >= 300 || answer.Text("issuer") != issuer || answer.Text("authorization_endpoint") is not { Length: > 0 } authorization || answer.Text("token_endpoint") is not string token || token.Length == 0)
            throw new SignInError(ProtocolFacts.SignInError("discovery"), "The issuer did not describe its endpoints", answer.Status);
        return new Endpoints(issuer, DiscoveryAddress(authorization, answer.Status), DiscoveryAddress(token, answer.Status),
            answer.Text("device_authorization_endpoint") is string device ? DiscoveryAddress(device, answer.Status) : null,
            answer.Text("revocation_endpoint") is string revocation ? DiscoveryAddress(revocation, answer.Status) : null);
    }

    internal async Task<Endpoints> DiscoverAsync(HttpEndpoint endpoint, CancellationToken cancellation)
    {
        string origin;
        try { origin = Gateway.Origin(endpoint); }
        catch (JsonException error) { throw new SignInError(ProtocolFacts.SignInError("discovery"), "Invalid gateway endpoint.", inner: error); }
        var answer = await AnswerAsync(origin + "/.well-known/oauth-protected-resource", errorCode: "discovery", cancellation: cancellation).ConfigureAwait(false);
        if (answer.Status == 404) throw new SignInError(ProtocolFacts.SignInError("no-issuer"), "The knowledge base trusts no external issuer", answer.Status);
        if (answer.Status is < 200 or >= 300) throw new SignInError(ProtocolFacts.SignInError("discovery"), "The gateway refused metadata discovery", answer.Status);
        ProtectedResourceMetadata metadata;
        try { metadata = answer.Body?.Deserialize<ProtectedResourceMetadata>() ?? throw new JsonException("No resource metadata"); }
        catch (JsonException error) { throw new SignInError(ProtocolFacts.SignInError("discovery"), "The gateway answered with invalid resource metadata", answer.Status, error); }
        if (metadata.AuthorizationServers.Count == 0) throw new SignInError(ProtocolFacts.SignInError("no-issuer"), "The knowledge base trusts no external issuer");
        return await ConfigurationAsync(metadata.AuthorizationServers[0], cancellation).ConfigureAwait(false);
    }

    public async Task SignInDeviceAsync(HttpEndpoint endpoint, ISignInKept kept, Action<DeviceCode> onCode, CancellationToken cancellation = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        var issuer = await DiscoverAsync(endpoint, linked.Token).ConfigureAwait(false);
        if (string.IsNullOrEmpty(issuer.Device)) throw new SignInError(ProtocolFacts.SignInError("discovery"), "The issuer has no device authorization endpoint");
        var answer = await AnswerAsync(issuer.Device, new Dictionary<string, string>
        { ["client_id"] = SignInPolicy.ScriptClientId, ["scope"] = SignInPolicy.Scope }, cancellation: linked.Token).ConfigureAwait(false);
        if (answer.Status != 200 || answer.Text("device_code") is not string device || device.Length == 0 ||
            answer.Text("user_code") is not string user || user.Length == 0 || answer.Text("verification_uri") is not string uri || uri.Length == 0 || answer.Seconds("expires_in") is not double expires)
            throw Failure("The issuer refused device authorization", answer.Status);
        var started = clock.GetTimestamp();
        onCode(new DeviceCode(user, uri, answer.Text("verification_uri_complete"), expires));
        var interval = Math.Max(answer.Seconds("interval") ?? ProtocolFacts.Timing("devicePollMs").GetDouble() / 1000, ProtocolFacts.Timing("devicePollFloorMs").GetDouble() / 1000);
        while (true)
        {
            var remaining = expires - clock.GetElapsedTime(started).TotalSeconds;
            if (remaining <= 0) throw new SignInError(ProtocolFacts.SignInError("expired"), "The device code expired");
            var wait = Math.Min(interval, remaining);
            // BCL timers cap a single wait; long issuer lifetimes keep their full deadline across chunks.
            while (wait > 0)
            {
                var chunk = Math.Min(wait, (uint.MaxValue - 1d) / 1000);
                await Task.Delay(TimeSpan.FromSeconds(chunk), clock, linked.Token).ConfigureAwait(false);
                wait -= chunk;
            }
            if (clock.GetElapsedTime(started).TotalSeconds >= expires) throw new SignInError(ProtocolFacts.SignInError("expired"), "The device code expired");
            var polled = await AnswerAsync(issuer.Token, new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
                ["device_code"] = device,
                ["client_id"] = SignInPolicy.ScriptClientId,
            }, cancellation: linked.Token).ConfigureAwait(false);
            if (polled.Status == 200)
            {
                var issued = Issued(polled);
                if (issued.Refresh is null) throw Failure("The issuer returned no refresh token", polled.Status);
                await kept.KeepAsync(new StoredSession
                {
                    Access = issued.Access,
                    Refresh = issued.Refresh,
                    ClientId = SignInPolicy.ScriptClientId,
                    TokenEndpoint = issuer.Token,
                    RevocationEndpoint = issuer.Revocation,
                }, linked.Token).ConfigureAwait(false);
                return;
            }
            switch (polled.Text("error"))
            {
                case "authorization_pending": break;
                case "slow_down": interval += ProtocolFacts.Timing("deviceSlowDownMs").GetDouble() / 1000; break;
                case "access_denied": throw new SignInError(ProtocolFacts.SignInError("denied"), "The sign-in was denied", polled.Status);
                case "expired_token": throw new SignInError(ProtocolFacts.SignInError("expired"), "The device code expired", polled.Status);
                default: throw Failure("The issuer refused the device grant", polled.Status);
            }
        }
    }

    public async Task SignOutAsync(ISignInKept kept, CancellationToken cancellation = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        linked.Token.ThrowIfCancellationRequested();
        var held = await kept.HeldAsync(linked.Token).ConfigureAwait(false);
        if (held is null) return;
        if (held.RevocationEndpoint is string endpoint)
        {
            try
            {
                await AnswerAsync(endpoint, new Dictionary<string, string>
                { ["token"] = held.Refresh, ["token_type_hint"] = "refresh_token", ["client_id"] = held.ClientId }, cancellation: linked.Token).ConfigureAwait(false);
            }
            catch (SignInError)
            {
                // Revocation is best effort; local sign-out still forgets credentials when the issuer is unavailable.
            }
        }
        await kept.ForgetAsync(linked.Token).ConfigureAwait(false);
    }
}
