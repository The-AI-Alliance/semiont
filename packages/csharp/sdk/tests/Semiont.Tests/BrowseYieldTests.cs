using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Theory]
    [InlineData("resourceContent", "")]
    [InlineData("resourceGraph", "/jsonld")]
    [InlineData("resourceAnchoredText", "/anchored-text")]
    [InlineData("resourceRepresentation", "")]
    [InlineData("resourceRepresentationStream", "")]
    public async Task BrowseContentFollowsItsSurfaceCases(string method, string suffix)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod("browse", method);

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            var resource = args.GetProperty("resourceId").Deserialize<ResourceId>();
            var expected = Text(example.GetProperty("sends"), "resourceId");
            var calls = 0;
            server.Other = (request, _) =>
            {
                Assert.Equal(HttpMethod.Get, request.Method);
                Assert.Equal("/resources/" + expected + suffix, request.RequestUri?.AbsolutePath);
                calls++;
                HttpContent body = method switch
                {
                    "resourceGraph" => JsonContent.Create(new GetResourceResponse { Resource = SourceResource(), Annotations = [] }),
                    "resourceAnchoredText" => new StringContent("""{"kind":"no-map"}""", Encoding.UTF8, "application/json"),
                    _ => new StringContent("hello", Encoding.UTF8, "text/plain"),
                };
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = body });
            };
            switch (method)
            {
                case "resourceContent": Assert.Equal("hello", await client.Browse.ResourceContentAsync(resource, deadline.Token)); break;
                case "resourceGraph": Assert.Equal(resource, (await client.Browse.ResourceGraphAsync(resource, deadline.Token)).Resource.Id); break;
                case "resourceAnchoredText": Assert.IsType<AnchoredTextAnswer.AnchoredTextAbsentCase>(await client.Browse.ResourceAnchoredTextAsync(resource, deadline.Token)); break;
                case "resourceRepresentation":
                    var bytes = await client.Browse.ResourceRepresentationAsync(resource, deadline.Token);
                    Assert.StartsWith("text/plain", bytes.ContentType);
                    Assert.Equal("hello", Encoding.UTF8.GetString(bytes.Bytes));
                    break;
                case "resourceRepresentationStream":
                    using (var stream = await client.Browse.ResourceRepresentationStreamAsync(resource, deadline.Token))
                    {
                        Assert.StartsWith("text/plain", stream.ContentType);
                        using var text = new StreamReader(stream.Stream, leaveOpen: true);
                        Assert.Equal("hello", await text.ReadToEndAsync(deadline.Token));
                        client.Dispose();
                        Assert.False(stream.Stream.CanRead);
                    }
                    break;
                default: throw new InvalidOperationException("Unknown content method " + method);
            }
            Assert.Equal(1, calls);
        }
    }

    [Theory]
    [InlineData("browse", "resourceEvents")]
    [InlineData("browse", "annotationHistory")]
    [InlineData("browse", "files")]
    [InlineData("browse", "kb")]
    [InlineData("yield", "cloneToken")]
    [InlineData("yield", "fromToken")]
    [InlineData("yield", "createFromToken")]
    public async Task BrowseAndYieldRequestsFollowTheirSurfaceCases(string space, string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod(space, method);
        var resource = ResourceId.Parse("res-1");
        var copied = ResourceId.Parse("copy");

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            switch (method)
            {
                case "resourceEvents":
                    server.Answer = sent => Reply(server, sent, BusOperations.BrowseEventsRequested.Result.Name, new BrowseEventsResult
                    {
                        Response = new GetEventsResponse { ResourceId = resource, Events = [], Total = 0 },
                    });
                    Assert.Empty(await client.Browse.ResourceEventsAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(), deadline.Token));
                    break;
                case "annotationHistory":
                    var annotation = args.GetProperty("annotationId").Deserialize<AnnotationId>();
                    server.Answer = sent => Reply(server, sent, BusOperations.BrowseAnnotationHistoryRequested.Result.Name,
                        new BrowseAnnotationHistoryResult
                        {
                            Response = new GetAnnotationHistoryResponse
                            {
                                ResourceId = resource,
                                AnnotationId = annotation,
                                Events = [],
                                Total = 0,
                            }
                        });
                    var history = await client.Browse.AnnotationHistoryAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(), annotation, deadline.Token);
                    Assert.Equal(annotation, history.AnnotationId);
                    break;
                case "files":
                    var listing = new BrowseDirectoryResultResponse { Path = Text(example.GetProperty("sends"), "path"), Entries = [] };
                    server.Answer = sent => Reply(server, sent, BusOperations.BrowseDirectoryRequested.Result.Name, new BrowseDirectoryResult { Response = listing });
                    var files = args.TryGetProperty("dirPath", out var path)
                        ? await client.Browse.FilesAsync(path.GetString() ?? throw new InvalidOperationException("Missing directory"),
                            args.GetProperty("sort").Deserialize<BrowseDirectoryRequestSort>(), deadline.Token)
                        : await client.Browse.FilesAsync(cancellation: deadline.Token);
                    Assert.Equal(listing.Path, files.Path);
                    break;
                case "kb":
                    server.Answer = sent => Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                        new BrowseKbResult { Response = new KbDescription { Domain = "example.org", Name = "Test KB" } });
                    Assert.Equal("example.org", (await client.Browse.KbAsync(deadline.Token)).Domain);
                    break;
                case "cloneToken":
                    server.Answer = sent => Reply(server, sent, BusOperations.YieldCloneTokenRequested.Result.Name,
                        new CloneResourceWithTokenResponseBusEnvelope
                        {
                            Response = new CloneResourceWithTokenResponse
                            {
                                Token = "token",
                                ExpiresAt = "2030-01-01T00:00:00Z",
                                Resource = SourceResource(),
                            }
                        });
                    Assert.Equal("token", (await client.Yield.CloneTokenAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(), deadline.Token)).Token);
                    break;
                case "fromToken":
                    server.Answer = sent => Reply(server, sent, BusOperations.YieldCloneResourceRequested.Result.Name,
                        new GetResourceByTokenResponseBusEnvelope
                        {
                            Response = new GetResourceByTokenResponse
                            {
                                SourceResource = SourceResource(),
                                ExpiresAt = "2030-01-01T00:00:00Z",
                            }
                        });
                    Assert.Equal(resource, (await client.Yield.FromTokenAsync(Text(args, "token"), deadline.Token)).Id);
                    break;
                case "createFromToken":
                    server.Answer = sent => Reply(server, sent, BusOperations.YieldCloneResourceRequested.Result.Name,
                        new { response = example.GetProperty("answers") });
                    var uploads = 0;
                    server.Other = async (request, cancellation) =>
                    {
                        Assert.True(server.Emits.Reader.TryPeek(out _));
                        var next = Assert.Single(example.GetProperty("then").EnumerateArray());
                        await VerifyUploadAsync(request, next.GetProperty("sends"), cancellation);
                        uploads++;
                        return new HttpResponseMessage(HttpStatusCode.Accepted) { Content = JsonContent.Create(new CreateResourceResponse { ResourceId = copied }) };
                    };
                    var options = args.GetProperty("options");
                    var clone = await client.Yield.CreateFromTokenAsync(Text(options, "token"), Text(options, "name"), Text(options, "content"),
                        cancellation: deadline.Token);
                    Assert.Equal(copied, clone.ResourceId);
                    Assert.Equal(1, uploads);
                    break;
                default: throw new InvalidOperationException("Unknown request " + method);
            }
            await ExpectRequestAsync(server, row, example, deadline.Token);
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }
    }

    [Theory]
    [InlineData("browse", "click")]
    [InlineData("browse", "openResource")]
    [InlineData("browse", "resourceViewed")]
    [InlineData("yield", "clone")]
    public async Task BrowseAndYieldSignalsFollowTheirSurfaceCases(string space, string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod(space, method);

        async Task VerifyLocalAsync<T>(BusChannel<T> channel, Action signal, JsonElement example) where T : class
        {
            await using var frames = client.Bus.Frames(channel, cancellation: deadline.Token).GetAsyncEnumerator();
            var next = frames.MoveNextAsync().AsTask();
            signal();
            Assert.True(await next);
            var frame = Assert.IsType<Heard<T>.Delivered>(frames.Current).Received.Frame;
            Assert.Equal(Text(row.GetProperty("via"), "local"), frame.Channel);
            Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), frame.Payload));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            switch (method)
            {
                case "click":
                    await VerifyLocalAsync(BusChannels.BrowseClick, () => client.Browse.Click(args.GetProperty("annotationId").Deserialize<AnnotationId>()), example);
                    break;
                case "openResource":
                    await VerifyLocalAsync(BusChannels.BrowseResourceOpen, () => client.Browse.OpenResource(args.GetProperty("resourceId").Deserialize<ResourceId>()), example);
                    break;
                case "resourceViewed":
                    client.Browse.ResourceViewed(args.GetProperty("resourceId").Deserialize<ResourceId>());
                    var (request, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
                    Assert.Equal(Text(row.GetProperty("via"), "emit"), Text(request, "channel"));
                    Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), request.GetProperty("payload")));
                    break;
                case "clone":
                    await VerifyLocalAsync(BusChannels.YieldClone, client.Yield.Clone, example);
                    break;
                default: throw new InvalidOperationException("Unknown signal " + method);
            }
        }
    }

    [Fact]
    public async Task YieldResourceStartsImmediatelyAndReportsProgressOnce()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod("yield", "resource");
        var created = ResourceId.Parse("uploaded");

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var data = example.GetProperty("args").GetProperty("data");
            var bytes = Encoding.UTF8.GetBytes(Text(data, "content"));
            var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            server.Other = async (request, cancellation) =>
            {
                await VerifyUploadAsync(request, example.GetProperty("sends"), cancellation);
                sent.SetResult();
                return new HttpResponseMessage(HttpStatusCode.Accepted) { Content = JsonContent.Create(new CreateResourceResponse { ResourceId = created }) };
            };
            using var upload = client.Yield.Resource(new ResourceUpload
            {
                Name = Text(data, "name"),
                File = bytes,
                Format = Text(data, "format"),
                StorageUri = Text(data, "storageUri"),
            }, deadline.Token);
            await sent.Task.WaitAsync(deadline.Token);
            var progress = new List<UploadProgress>();
            await foreach (var update in upload.WithCancellation(deadline.Token)) progress.Add(update);
            Assert.Throws<InvalidOperationException>(() => upload.GetAsyncEnumerator());
            Assert.Equal([new UploadProgress(0, bytes.Length), new UploadProgress(bytes.Length, bytes.Length)], progress);
            Assert.Equal(created, (await upload).ResourceId);
        }
    }

    [Fact]
    public async Task DisposingTheUploadAbandonsTheHttpRequest()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.Other = async (_, cancellation) =>
        {
            sent.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
            return new HttpResponseMessage(HttpStatusCode.Accepted);
        };
        using var upload = client.Yield.Resource(new ResourceUpload { Name = "Notes", File = [1], Format = "text/plain", StorageUri = "file://notes.txt" });
        await sent.Task.WaitAsync(deadline.Token);
        upload.Dispose();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => upload.CompleteAsync().WaitAsync(deadline.Token));
    }

    private static ResourceDescriptor SourceResource() => Required<ResourceDescriptor>(
        SurfaceFixture("context").GetProperty("focus").GetProperty("resource"));

    private static async Task VerifyUploadAsync(HttpRequestMessage request, JsonElement expected, CancellationToken cancellation)
    {
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/resources", request.RequestUri?.AbsolutePath);
        var multipart = Assert.IsType<MultipartFormDataContent>(request.Content);
        var actual = new Dictionary<string, string>();
        foreach (var part in multipart)
        {
            var name = part.Headers.ContentDisposition?.Name?.Trim('"') ?? throw new InvalidOperationException("Unnamed multipart part");
            var value = await part.ReadAsStringAsync(cancellation);
            if (name == "file")
            {
                Assert.Equal(Text(expected, "format"), part.Headers.ContentType?.MediaType);
                actual.Add("content", value);
            }
            else actual.Add(name, value);
        }
        Assert.True(JsonElement.DeepEquals(expected, JsonSerializer.SerializeToElement(actual)));
    }
}
