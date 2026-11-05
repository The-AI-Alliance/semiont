using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class AuthNamespace
{
    private readonly HttpTransport transport;

    internal AuthNamespace(HttpTransport transport) => this.transport = transport;

    public Task<UserResponse> MeAsync(CancellationToken cancellation = default) =>
        transport.GetCurrentUserAsync(cancellation);

    public Task<MediaTokenResponse> MediaTokenAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        transport.GetMediaTokenAsync(resourceId, cancellation);

    public Task<ProtectedResourceMetadata> ProtectedResourceMetadataAsync(CancellationToken cancellation = default) =>
        transport.GetProtectedResourceMetadataAsync(cancellation);
}
