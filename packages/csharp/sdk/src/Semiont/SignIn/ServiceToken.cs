using System.Security.Cryptography;
using System.Buffers.Text;
using System.Text;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Session;

namespace Semiont.SignIn;

public sealed class ServiceToken : IDisposable
{
    private readonly Issuer issuer;
    private readonly string authority;
    private readonly Func<string, Dictionary<string, string>> proof;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private string? endpoint;
    private string? token;
    private long obtained;
    private double reuseSeconds;
    private Task<string>? asking;
    private bool disposed;

    public ServiceToken(string authority, string clientId, string clientSecret, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
    {
        this.authority = authority;
        clock = timeProvider ?? TimeProvider.System;
        issuer = new Issuer(httpClient, clock, random);
        proof = _ => new Dictionary<string, string>
        {
            ["grant_type"] = ClientAssertion.GrantType,
            ["client_id"] = clientId,
            ["client_secret"] = clientSecret,
        };
    }

    /// <summary>The caller owns the RSA key and keeps it usable for this token's lifetime.</summary>
    public ServiceToken(string authority, string clientId, RSA privateKey, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
    {
        this.authority = authority;
        clock = timeProvider ?? TimeProvider.System;
        issuer = new Issuer(httpClient, clock, random);
        proof = address => ClientAssertion.Form(privateKey, clientId, address, clock.GetUtcNow().ToUnixTimeSeconds(), Guid.NewGuid().ToString("N"));
    }

    public async Task<string> AuthorizationAsync(CancellationToken cancellation = default) =>
        "Bearer " + await TokenAsync(null, false, cancellation).ConfigureAwait(false);

    internal Task<string> TokenAsync(string? refused, bool retry, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (asking is { IsCompleted: false }) return asking.WaitAsync(cancellation);
            if (token is not null && token != refused && clock.GetElapsedTime(obtained).TotalSeconds < reuseSeconds)
                return Task.FromResult(token);
            asking = Task.Run(() => retry ? issuer.RetryAsync(GrantAsync, CancellationToken.None) : GrantAsync(CancellationToken.None));
            return asking.WaitAsync(cancellation);
        }
    }

    private async Task<string> GrantAsync(CancellationToken cancellation)
    {
        endpoint ??= (await issuer.ConfigurationAsync(authority, cancellation).ConfigureAwait(false)).Token;
        var answer = await issuer.AnswerAsync(endpoint, proof(endpoint), cancellation: cancellation).ConfigureAwait(false);
        if (answer.Status is < 200 or >= 300 || answer.Text("access_token") is not { Length: > 0 } access)
            throw new SignInError(ProtocolFacts.SignInError("exchange"), "The issuer refused the client credentials grant", answer.Status);

        var expires = answer.Seconds("expires_in");
        var delay = Tokens.RefreshDelay(access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d)
            ?? (expires is double lifetime ? Tokens.RenewalDelay(lifetime, lifetime) : 0);
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            token = access;
            obtained = clock.GetTimestamp();
            reuseSeconds = expires is double limit ? Math.Min(delay, limit) : delay;
        }
        return access;
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
        }
        issuer.Dispose();
    }
}

internal static class ClientAssertion
{
    private static readonly JsonElement Policy = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.ClientAssertion);
    internal static string GrantType => Policy.GetProperty("grantType").GetString() ?? throw new InvalidOperationException("Missing client grant type");

    internal static string Thumbprint(string modulus, string exponent) =>
        Base64Url.EncodeToString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { e = exponent, kty = "RSA", n = modulus })));

    internal static byte[] Header(string modulus, string exponent) =>
        JsonSerializer.SerializeToUtf8Bytes(new { alg = "RS256", kid = Thumbprint(modulus, exponent) });

    internal static byte[] Claims(string clientId, string endpoint, long issuedAt, string id) =>
        JsonSerializer.SerializeToUtf8Bytes(new
        {
            iss = clientId,
            sub = clientId,
            aud = endpoint,
            jti = id,
            iat = issuedAt,
            exp = issuedAt + Policy.GetProperty("lifetimeSeconds").GetInt64(),
        });

    internal static Dictionary<string, string> Form(RSA key, string clientId, string endpoint, long issuedAt, string id)
    {
        var parameters = key.ExportParameters(false);
        var modulus = parameters.Modulus ?? throw new CryptographicException("RSA modulus is absent");
        var exponent = parameters.Exponent ?? throw new CryptographicException("RSA public exponent is absent");
        var header = Header(Base64Url.EncodeToString(modulus), Base64Url.EncodeToString(exponent));
        var input = Base64Url.EncodeToString(header) + "." + Base64Url.EncodeToString(Claims(clientId, endpoint, issuedAt, id));
        var signature = key.SignData(Encoding.ASCII.GetBytes(input), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return new Dictionary<string, string>
        {
            ["grant_type"] = GrantType,
            ["client_assertion_type"] = Policy.GetProperty("assertionType").GetString() ?? throw new InvalidOperationException("Missing assertion type"),
            ["client_assertion"] = input + "." + Base64Url.EncodeToString(signature),
        };
    }
}
