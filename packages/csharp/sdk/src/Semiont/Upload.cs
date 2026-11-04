using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Semiont.Http;
using Semiont.Types;

namespace Semiont;

/// <summary>An upload that starts immediately. Read its progress once and await the created resource.</summary>
public sealed class Upload : IAsyncEnumerable<UploadProgress>, IDisposable
{
    private readonly object gate = new();
    private readonly CancellationTokenSource stopping;
    private readonly Channel<UploadProgress> progress = Channel.CreateUnbounded<UploadProgress>(
        new UnboundedChannelOptions { SingleReader = true });
    private readonly Task<CreateResourceResponse> completion;
    private bool finished;
    private int consumed;

    internal Upload(HttpContentTransport content, ResourceUpload request, CancellationToken cancellation)
    {
        stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        completion = SendAsync(content, request);
    }

    public async Task<CreateResourceResponse> CompleteAsync(CancellationToken cancellation = default)
    {
        using var registration = cancellation.Register(Dispose);
        return await completion.WaitAsync(cancellation).ConfigureAwait(false);
    }

    public TaskAwaiter<CreateResourceResponse> GetAwaiter() => CompleteAsync().GetAwaiter();

    public IAsyncEnumerator<UploadProgress> GetAsyncEnumerator(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref consumed, 1) != 0)
            throw new InvalidOperationException("Upload progress can be read once.");
        return ReadAsync(cancellationToken).GetAsyncEnumerator();
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (!finished) stopping.Cancel();
        }
    }

    private async IAsyncEnumerable<UploadProgress> ReadAsync([EnumeratorCancellation] CancellationToken cancellation)
    {
        try
        {
            await foreach (var update in progress.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
                yield return update;
            await completion.ConfigureAwait(false);
        }
        finally { Dispose(); }
    }

    private async Task<CreateResourceResponse> SendAsync(HttpContentTransport content, ResourceUpload request)
    {
        try
        {
            stopping.Token.ThrowIfCancellationRequested();
            return await content.UploadAsync(request, new Reporter(progress.Writer), stopping.Token).ConfigureAwait(false);
        }
        finally
        {
            lock (gate)
            {
                finished = true;
                progress.Writer.TryComplete();
                // Dispose under the same lock used to cancel the in-flight upload.
                stopping.Dispose();
            }
        }
    }

    private sealed class Reporter(ChannelWriter<UploadProgress> writer) : IProgress<UploadProgress>
    {
        public void Report(UploadProgress value) => writer.TryWrite(value);
    }
}
