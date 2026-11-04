using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Theory]
    [InlineData("annotation")]
    [InlineData("delete")]
    [InlineData("archive")]
    [InlineData("unarchive")]
    [InlineData("updateEntityTypes")]
    public async Task MarkCommandsFollowTheirSurfaceCases(string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod("mark", method);
        var annotationId = AnnotationId.Parse("ann-1");

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            var resource = args.TryGetProperty("resourceId", out var resourceId) ? resourceId.Deserialize<ResourceId>() : default;
            switch (method)
            {
                case "annotation":
                    server.Answer = sent => Reply(server, sent, BusOperations.MarkCreateRequest.Result.Name,
                        new MarkCreateOk { Response = new MarkCreateOkResponse { AnnotationId = annotationId } });
                    var created = await client.Mark.AnnotationAsync(Required<CreateAnnotationRequest>(args.GetProperty("input")), deadline.Token);
                    Assert.Equal(annotationId, created.AnnotationId);
                    break;
                case "delete":
                    var deleted = args.GetProperty("annotationId").Deserialize<AnnotationId>();
                    server.Answer = sent => Reply(server, sent, BusOperations.MarkDelete.Result.Name,
                        new MarkDeleteOk { Response = new MarkDeleteOkResponse { AnnotationId = deleted } });
                    await client.Mark.DeleteAsync(resource, deleted, deadline.Token);
                    break;
                case "archive":
                    server.Answer = sent => Reply(server, sent, BusOperations.MarkArchive.Result.Name, new EmptyBusPayload());
                    await client.Mark.ArchiveAsync(resource, deadline.Token);
                    break;
                case "unarchive":
                    server.Answer = sent => Reply(server, sent, BusOperations.MarkUnarchive.Result.Name, new EmptyBusPayload());
                    await client.Mark.UnarchiveAsync(resource, deadline.Token);
                    break;
                case "updateEntityTypes":
                    server.Answer = sent => Reply(server, sent, BusOperations.MarkUpdateEntityTypes.Result.Name, new EmptyBusPayload());
                    await client.Mark.UpdateEntityTypesAsync(resource, Required<string[]>(args.GetProperty("current")),
                        Required<string[]>(args.GetProperty("updated")), deadline.Token);
                    break;
                default: throw new InvalidOperationException("Unknown Mark command: " + method);
            }
            await ExpectRequestAsync(server, row, example, deadline.Token);
        }
    }

    [Theory]
    [InlineData("request")]
    [InlineData("submit")]
    [InlineData("reportDeleteError")]
    public async Task MarkSignalsFollowTheirSurfaceCases(string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod("mark", method);

        async Task VerifyAsync<T>(BusChannel<T> channel, Action emit, JsonElement example) where T : class
        {
            await using var frames = client.Bus.Frames(channel, cancellation: deadline.Token).GetAsyncEnumerator();
            var next = frames.MoveNextAsync().AsTask();
            emit();
            Assert.True(await next);
            var delivered = Assert.IsType<Heard<T>.Delivered>(frames.Current);
            Assert.Equal(row.GetProperty("via").GetProperty("local").GetString(), delivered.Received.Frame.Channel);
            Assert.True(JsonElement.DeepEquals(ExpandSurfaceFixtures(example.GetProperty("sends")), delivered.Received.Frame.Payload));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = ExpandSurfaceFixtures(example.GetProperty("args"));
            switch (method)
            {
                case "request":
                    var request = Required<MarkRequestedEvent>(args);
                    await VerifyAsync(BusChannels.MarkRequested, () => client.Mark.Request(request.Source, request.Selector, request.Motivation), example);
                    break;
                case "submit":
                    await VerifyAsync(BusChannels.MarkSubmit, () => client.Mark.Submit(Required<MarkSubmitEvent>(args.GetProperty("input"))), example);
                    break;
                case "reportDeleteError":
                    await VerifyAsync(BusChannels.MarkDeleteError, () => client.Mark.ReportDeleteError(Required<ResourceErrorEvent>(args.GetProperty("input"))), example);
                    break;
                default: throw new InvalidOperationException("Unknown Mark signal: " + method);
            }
        }
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("progress")]
    [InlineData("complete")]
    [InlineData("fail")]
    public async Task JobEventsFollowTheirSurfaceCases(string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod("job", method);
        var channel = row.GetProperty("via").GetProperty("observes").GetString() ?? throw new InvalidOperationException("Missing job channel");
        using var client = new SemiontClient(new HttpTransport("http://unit.test", "token", [channel], httpClient: http));
        await OpenAsync(client.Transport);

        async Task VerifyAsync<T>(IAsyncEnumerable<Heard<T>> events) where T : class
        {
            await using var frames = events.GetAsyncEnumerator(deadline.Token);
            foreach (var example in row.GetProperty("cases").EnumerateArray())
            {
                var payload = example.GetProperty("sends");
                var next = frames.MoveNextAsync().AsTask();
                server.Stream.Push("event: bus-event\ndata: " + JsonSerializer.Serialize(new { channel, payload }) + "\n\n");
                Assert.True(await next);
                var delivered = Assert.IsType<Heard<T>.Delivered>(frames.Current);
                Assert.Equal(channel, delivered.Received.Frame.Channel);
                Assert.True(JsonElement.DeepEquals(payload, JsonSerializer.SerializeToElement(delivered.Payload)));
            }
        }

        switch (method)
        {
            case "queued": await VerifyAsync(client.Job.Queued()); break;
            case "progress": await VerifyAsync(client.Job.Progress()); break;
            case "complete": await VerifyAsync(client.Job.Complete()); break;
            case "fail": await VerifyAsync(client.Job.Fail()); break;
            default: throw new InvalidOperationException("Unknown Job event: " + method);
        }
    }

    [Theory]
    [InlineData("status")]
    [InlineData("cancel")]
    [InlineData("pollUntilComplete")]
    public async Task JobRequestsFollowTheirSurfaceCases(string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod("job", method);

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var job = example.GetProperty("args").GetProperty("jobId").Deserialize<JobId>();
            var finished = JobStatus(job, JobStatusResponseStatus.Complete);
            switch (method)
            {
                case "status":
                    server.Answer = sent => Reply(server, sent, BusOperations.JobStatusRequested.Result.Name, finished);
                    Assert.Equal(finished.Response, await client.Job.StatusAsync(job, deadline.Token));
                    break;
                case "cancel":
                    foreach (var accepted in new[] { false, true })
                    {
                        server.Answer = sent => Reply(server, sent, BusOperations.JobCancelRequested.Result.Name,
                            new JobCancelResultBusEnvelope { Response = new JobCancelResult { Cancelled = accepted } });
                        Assert.Equal(accepted, await client.Job.CancelAsync(job, deadline.Token));
                        await ExpectRequestAsync(server, row, example, deadline.Token);
                    }
                    continue;
                case "pollUntilComplete":
                    var statuses = new List<JobStatusResponseStatus>();
                    var responses = new Queue<JobStatusResult>([JobStatus(job, JobStatusResponseStatus.Running), finished]);
                    server.Answer = sent => Reply(server, sent, BusOperations.JobStatusRequested.Result.Name, responses.Dequeue());
                    Assert.Equal(finished.Response, await client.Job.PollUntilCompleteAsync(job, intervalMs: 1,
                        onStatus: status => statuses.Add(status.Status), cancellation: deadline.Token));
                    Assert.Equal([JobStatusResponseStatus.Running, JobStatusResponseStatus.Complete], statuses);
                    await ExpectRequestAsync(server, row, example, deadline.Token);
                    break;
                default: throw new InvalidOperationException("Unknown Job request: " + method);
            }
            await ExpectRequestAsync(server, row, example, deadline.Token);
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }
    }

    [Fact]
    public async Task JobPollDeadlineAppliesWhileAStatusReplyIsPending()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new FakeTimeProvider();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var polling = client.Job.PollUntilCompleteAsync(JobId.Parse("job-1"), timeoutMs: 100, cancellation: deadline.Token);
        await server.Emits.Reader.ReadAsync(deadline.Token);
        clock.Advance(TimeSpan.FromMilliseconds(100));
        var error = await Assert.ThrowsAsync<BusRequestError>(() => polling);
        Assert.Equal("bus.timeout", error.Code);
        Assert.False(server.Emits.Reader.TryPeek(out _));
    }

    private static async Task ExpectRequestAsync(Handler server, JsonElement row, JsonElement example, CancellationToken cancellation)
    {
        var (body, _) = await server.Emits.Reader.ReadAsync(cancellation);
        Assert.Equal(row.GetProperty("via").GetProperty("request").GetString(), body.GetProperty("channel").GetString());
        Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), body.GetProperty("payload")));
    }

    private static JobStatusResult JobStatus(JobId jobId, JobStatusResponseStatus status) => new()
    {
        Response = new JobStatusResponse
        {
            JobId = jobId,
            Status = status,
            Type = JobType.Mark,
            UserId = UserId.Parse("did:web:example.org:users:alice"),
            Created = "2026-11-04T00:00:00Z",
        },
    };
}
