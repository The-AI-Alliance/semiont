using Semiont.Errors;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Net.Http.Headers;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Http;

public sealed record BinaryContent(string ContentType, byte[] Bytes);
public sealed record BinaryStream(string ContentType, Stream Stream) : IDisposable
{
    public void Dispose() => Stream.Dispose();
}

public sealed record UploadProgress(long BytesUploaded, long TotalBytes);

public sealed class HttpContentTransport(HttpTransport transport) : IDisposable
{
    private readonly CancellationTokenSource lifetime = new();
    private readonly object gate = new();
    private readonly HashSet<Stream> streams = [];
    private bool closed;

    public void Dispose()
    {
        Stream[] ending;
        lock (gate)
        {
            if (closed) return;
            closed = true;
            ending = streams.ToArray();
            streams.Clear();
        }
        try { lifetime.Cancel(); }
        finally
        {
            foreach (var stream in ending) stream.Dispose();
            lifetime.Dispose();
        }
    }

    private void Released(Stream stream) { lock (gate) { streams.Remove(stream); } }

    private CancellationTokenSource Link(CancellationToken cancellation)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(closed, this);
            return CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellation);
        }
    }

    public async Task<ResourceId> PutBinaryAsync(ResourceUpload request, IProgress<UploadProgress>? progress = null, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        using var activity = SdkTelemetry.Start("content.put", new ActivityTagsCollection { { "content.format", request.Format }, { "content.size_bytes", request.File.LongLength } });
        using var response = await transport.ExchangeAsync(HttpMethod.Post, "/resources", () =>
        {
            var form = new MultipartFormDataContent();
            var metadata = JsonSerializer.SerializeToElement(request);
            foreach (var field in metadata.EnumerateObject())
            {
                if (field.Name == "file") continue;
                form.Add(new StringContent(field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString() ?? throw new JsonException("Null upload member") : field.Value.GetRawText()), field.Name);
            }
            var file = new ProgressContent(request.File, progress);
            file.Headers.ContentType = new MediaTypeHeaderValue(request.Format);
            form.Add(file, "file", request.Name);
            return form;
        }, upload: true, cancellation: cancellation).ConfigureAwait(false);
        var created = await response.Content.ReadFromJsonAsync<CreateResourceResponse>(cancellation).ConfigureAwait(false)
            ?? throw new TransportError(TransportFacts.Error(0), "Upload returned null");
        return created.ResourceId;
    }

    public async Task<BinaryContent> GetBinaryAsync(ResourceId resource, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        using var activity = SdkTelemetry.Start("content.get", new ActivityTagsCollection { { "resource.id", resource.Value } });
        using var response = await transport.ExchangeAsync(HttpMethod.Get, Path(resource), cancellation: cancellation).ConfigureAwait(false);
        return new BinaryContent(response.Content.Headers.ContentType?.ToString() ?? throw new TransportError(TransportFacts.Error(0), "The content response has no media type"), await response.Content.ReadAsByteArrayAsync(cancellation).ConfigureAwait(false));
    }

    public async Task<BinaryStream> GetBinaryStreamAsync(ResourceId resource, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        var activity = SdkTelemetry.Start("content.get", new ActivityTagsCollection { { "resource.id", resource.Value }, { "content.stream", true } });
        var response = await transport.ExchangeAsync(HttpMethod.Get, Path(resource), cancellation: cancellation).ConfigureAwait(false);
        try
        {
            var mediaType = response.Content.Headers.ContentType?.ToString() ?? throw new TransportError(TransportFacts.Error(0), "The content response has no media type");
            var stream = new ResponseStream(await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false), response, activity, lifetime.Token, Released);
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(closed, this);
                streams.Add(stream);
            }
            return new BinaryStream(mediaType, stream);
        }
        catch { activity?.Dispose(); response.Dispose(); throw; }
    }

    public async Task<GetResourceResponse> GetResourceGraphAsync(ResourceId resource, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        using var activity = SdkTelemetry.Start("content.get_graph", new ActivityTagsCollection { { "resource.id", resource.Value } });
        return await transport.AnswerAsync<GetResourceResponse>(HttpMethod.Get, Path(resource) + "/jsonld", cancellation: cancellation).ConfigureAwait(false);
    }
    public async Task<GetAnnotationsResponse> GetAnnotationsAsync(ResourceId resource, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        using var activity = SdkTelemetry.Start("content.get_annotations", new ActivityTagsCollection { { "resource.id", resource.Value } });
        return await transport.AnswerAsync<GetAnnotationsResponse>(HttpMethod.Get, Path(resource) + "/annotations", cancellation: cancellation).ConfigureAwait(false);
    }
    public async Task<AnchoredTextAnswer> GetAnchoredTextAsync(ResourceId resource, CancellationToken cancellation = default)
    {
        using var linked = Link(cancellation);
        cancellation = linked.Token;
        using var activity = SdkTelemetry.Start("content.get_anchored_text", new ActivityTagsCollection { { "resource.id", resource.Value } });
        return await transport.AnswerAsync<AnchoredTextAnswer>(HttpMethod.Get, Path(resource) + "/anchored-text", cancellation: cancellation).ConfigureAwait(false);
    }
    private static string Path(ResourceId resource) => "/resources/" + Uri.EscapeDataString(resource.Value);

    private sealed class ProgressContent(byte[] bytes, IProgress<UploadProgress>? progress) : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = bytes.LongLength; return true; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => SerializeToStreamAsync(stream, context, CancellationToken.None);
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken)
        {
            progress?.Report(new UploadProgress(0, bytes.LongLength));
            for (var offset = 0; offset < bytes.Length;)
            {
                var count = Math.Min(65536, bytes.Length - offset);
                await stream.WriteAsync(bytes.AsMemory(offset, count), cancellationToken).ConfigureAwait(false);
                offset += count;
                progress?.Report(new UploadProgress(offset, bytes.LongLength));
            }
        }
    }

    private sealed class ResponseStream(Stream stream, HttpResponseMessage response, Activity? activity, CancellationToken lifetime, Action<Stream> released) : Stream
    {
        private int closed;
        public override bool CanRead => Volatile.Read(ref closed) == 0 && stream.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => stream.Read(buffer, offset, count);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(lifetime, cancellationToken);
            return await stream.ReadAsync(buffer, linked.Token).ConfigureAwait(false);
        }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing && Interlocked.Exchange(ref closed, 1) == 0)
            {
                stream.Dispose();
                response.Dispose();
                activity?.Dispose();
                released(this);
            }
            base.Dispose(disposing);
        }
    }
}
