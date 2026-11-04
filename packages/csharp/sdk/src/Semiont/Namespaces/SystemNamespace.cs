using Semiont.Http;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class SystemNamespace
{
    private readonly HttpTransport transport;

    internal SystemNamespace(HttpTransport transport) => this.transport = transport;

    public Task<HealthResponse> HealthCheckAsync(CancellationToken cancellation = default) =>
        transport.HealthCheckAsync(cancellation);

    public Task<StatusResponse> StatusAsync(CancellationToken cancellation = default) =>
        transport.GetStatusAsync(cancellation);
}
