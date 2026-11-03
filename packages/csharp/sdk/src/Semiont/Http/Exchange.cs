using Semiont.Protocol;
using Semiont.Errors;
using System.Net.Http.Json;
using System.Text.Json;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Http;

public sealed partial class HttpTransport
{
    public Task<HealthResponse> HealthCheckAsync(CancellationToken cancellation = default) => AnswerAsync<HealthResponse>(HttpMethod.Get, "/api/health", cancellation: cancellation);
    public Task<StatusResponse> GetStatusAsync(CancellationToken cancellation = default) => AnswerAsync<StatusResponse>(HttpMethod.Get, "/api/status", cancellation: cancellation);
    public Task<UserResponse> GetCurrentUserAsync(CancellationToken cancellation = default) => AnswerAsync<UserResponse>(HttpMethod.Get, "/api/users/me", cancellation: cancellation);
    public Task<ProtectedResourceMetadata> GetProtectedResourceMetadataAsync(CancellationToken cancellation = default) => AnswerAsync<ProtectedResourceMetadata>(HttpMethod.Get, "/.well-known/oauth-protected-resource", authenticated: false, cancellation: cancellation);
    public Task<MediaTokenResponse> GetMediaTokenAsync(ResourceId resource, CancellationToken cancellation = default) => AnswerAsync<MediaTokenResponse>(HttpMethod.Post, "/api/tokens/media", () => JsonContent.Create(new MediaTokenRequest { ResourceId = resource }), cancellation: cancellation);

    internal async Task<T> AnswerAsync<T>(HttpMethod method, string path, Func<HttpContent>? content = null, bool authenticated = true, CancellationToken cancellation = default, bool retry = true)
    {
        using var response = await ExchangeAsync(method, path, content, authenticated, cancellation: cancellation, retry: retry).ConfigureAwait(false);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timing.HttpRequestMs), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, lifetime.Token, cancellation);
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(linked.Token).ConfigureAwait(false)
                ?? throw new TransportError(ProtocolFacts.Error(0), path + ": null response");
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            throw Report(new TransportError(ProtocolFacts.Error(503), path + ": response was not read"));
        }
        catch (JsonException error)
        {
            throw Report(new TransportError(ProtocolFacts.Error(0), error.Message, (int)response.StatusCode, error));
        }
    }

    internal async Task<HttpResponseMessage> ExchangeAsync(HttpMethod method, string path, Func<HttpContent>? content = null, bool authenticated = true, bool upload = false, CancellationToken cancellation = default, bool retry = true)
    {
        var renewed = false;
        for (var attempt = 0; ; attempt++)
        {
            var sent = authenticated ? Token() : null;
            using var request = Request(method, path, sent);
            request.Content = content?.Invoke();
            using var deadline = new CancellationTokenSource(upload ? Timeout.InfiniteTimeSpan : TimeSpan.FromMilliseconds(timing.HttpRequestMs), clock);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, lifetime.Token, cancellation);
            HttpResponseMessage response;
            try
            {
                response = await SendAsync(request, linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
            {
                throw Report(new TransportError(ProtocolFacts.Error(503), path + ": no response"));
            }
            catch (HttpRequestException error)
            {
                if (retry && attempt == 0 && method == HttpMethod.Get)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("requestRetryPauseMs").GetInt32()), clock, linked.Token).ConfigureAwait(false);
                    continue;
                }
                throw Report(new TransportError(ProtocolFacts.Error(503), error.Message, inner: error));
            }
            if (response.IsSuccessStatusCode) return response;
            var failure = await RefusalAsync(response, cancellation).ConfigureAwait(false);
            if (failure.Code == ProtocolFacts.Error(401) && !renewed && sent is not null)
            {
                renewed = true;
                if (await RenewAsync(sent, cancellation).ConfigureAwait(false))
                {
                    response.Dispose();
                    attempt--;
                    continue;
                }
            }
            if (retry && attempt == 0 && method == HttpMethod.Get && (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500) && failure.Code != ProtocolFacts.Error(401))
            {
                var delay = Math.Max(RetryAfter(response), ProtocolFacts.Timing("requestRetryPauseMs").GetInt32());
                response.Dispose();
                await Task.Delay(TimeSpan.FromMilliseconds(delay), clock, linked.Token).ConfigureAwait(false);
                continue;
            }
            response.Dispose();
            throw Report(failure);
        }
    }

    private TransportError Report(TransportError error) { failures.Publish(error); return error; }
}
