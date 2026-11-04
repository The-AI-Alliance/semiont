using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    private static readonly JobId DelegatedJob = JobId.Parse("job-1");
    private static readonly ResourceId DelegatedResource = ResourceId.Parse("res-1");
    private static readonly TimeSpan JobSilence = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("jobSilenceMs").GetInt32());
    private static readonly TimeSpan JobPoll = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("jobStatusPollMs").GetInt32());

    [Theory]
    [InlineData("mark")]
    [InlineData("yield")]
    public async Task DelegationSurfaceNamesTheJobBeforeEarlyFrames(string space)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod(space, "delegate");

        async Task VerifyAsync<T>(Delegation<T> delegation, JobCompleteCommand complete, JobType type, JsonElement example)
        {
            server.Answer = sent =>
            {
                PushJobFrame(server, BusChannels.JobReportProgress, Progress(JobId.Parse("other-job"), type, 90));
                PushJobFrame(server, BusChannels.JobReportProgress, Progress(DelegatedJob, type, 10));
                PushJobFrame(server, BusChannels.JobFail, Setback(type));
                PushJobFrame(server, BusChannels.JobReportProgress, Progress(DelegatedJob, type, 20));
                PushJobFrame(server, BusChannels.JobComplete, complete);
                AnswerCreate(server, sent);
            };
            Assert.False(server.Emits.Reader.TryPeek(out _));
            await using var reader = delegation.GetAsyncEnumerator(deadline.Token);
            Assert.False(server.Emits.Reader.TryPeek(out _));
            Assert.Throws<InvalidOperationException>(() => delegation.GetAsyncEnumerator());
            await Assert.ThrowsAsync<InvalidOperationException>(() => delegation.CompleteAsync(deadline.Token));

            Assert.True(await reader.MoveNextAsync());
            Assert.Equal(DelegatedJob, Assert.IsType<JobEvent<T>.Created>(reader.Current).Value.JobId);
            Assert.True(await reader.MoveNextAsync());
            Assert.Equal(10, Assert.IsType<JobEvent<T>.Progress>(reader.Current).Value.Percentage);
            Assert.True(await reader.MoveNextAsync());
            Assert.Equal("retry", Assert.IsType<JobEvent<T>.Failed>(reader.Current).Value.Error);
            Assert.True(await reader.MoveNextAsync());
            Assert.Equal(20, Assert.IsType<JobEvent<T>.Progress>(reader.Current).Value.Percentage);
            Assert.True(await reader.MoveNextAsync());
            Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(complete),
                JsonSerializer.SerializeToElement(Assert.IsType<JobEvent<T>.Complete>(reader.Current).Value)));
            Assert.False(await reader.MoveNextAsync());

            var (body, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(row.GetProperty("via").GetProperty("request").GetString(), body.GetProperty("channel").GetString());
            Assert.True(JsonElement.DeepEquals(ExpandSurfaceFixtures(example.GetProperty("sends")), body.GetProperty("payload")));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = ExpandSurfaceFixtures(example.GetProperty("args"));
            if (space == "mark")
            {
                var resource = args.GetProperty("resourceId").Deserialize<ResourceId>();
                await VerifyAsync(client.Mark.Delegate(resource, Required<MarkJobParams>(args.GetProperty("params"))),
                    new JobCompleteCommand.MarkJobCompleteCommandCase(new MarkJobCompleteCommand
                    {
                        JobId = DelegatedJob,
                        ResourceId = resource,
                    }), JobType.Mark, example);
            }
            else
            {
                var parameters = Required<GenerationJobParams>(args.GetProperty("params"));
                var delegation = args.TryGetProperty("stallDeadlineMs", out var stall)
                    ? client.Yield.Delegate(parameters, stall.GetInt32())
                    : client.Yield.Delegate(parameters);
                await VerifyAsync(delegation, new JobCompleteCommand.YieldJobCompleteCommandCase(new YieldJobCompleteCommand
                {
                    JobId = DelegatedJob,
                    ResourceId = DelegatedResource,
                }), JobType.Yield, example);
            }
        }
    }

    [Theory]
    [InlineData(JobStatusResponseStatus.Complete)]
    [InlineData(JobStatusResponseStatus.Failed)]
    [InlineData(JobStatusResponseStatus.Cancelled)]
    public async Task SilentDelegationPollsAgainAfterARefusalAndLearnsTheTerminalStatus(JobStatusResponseStatus terminal)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new TestClock();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var following = client.Yield.Delegate(GenerationParameters()).CompleteAsync(deadline.Token);
        await AcceptDelegationAsync(server, deadline.Token);

        await clock.WaitForAsync(JobSilence);
        clock.Advance(JobSilence);
        var first = await ReadJobRequestAsync(server, BusOperations.JobStatusRequested.Request.Name, deadline.Token);
        Reply(server, first, BusOperations.JobStatusRequested.Failure.Name, new { error = "try again" });

        await clock.WaitForAsync(JobPoll);
        clock.Advance(JobPoll);
        var second = await ReadJobRequestAsync(server, BusOperations.JobStatusRequested.Request.Name, deadline.Token);
        var reply = JobStatus(DelegatedJob, terminal);
        var generated = new YieldJobDone { ResourceId = ResourceId.Parse("generated"), ResourceName = "Notes", Truncated = true };
        Reply(server, second, BusOperations.JobStatusRequested.Result.Name, reply with
        {
            Response = reply.Response with
            {
                Type = JobType.Yield,
                Result = terminal == JobStatusResponseStatus.Complete
                    ? new JobStoredResult.JobResultCase(new JobResult.YieldJobDoneCase(generated)) : null,
                Error = terminal == JobStatusResponseStatus.Failed ? "model refused" : null,
                FailureClass = terminal == JobStatusResponseStatus.Failed ? FailureClass.Withheld : null,
            },
        });

        if (terminal == JobStatusResponseStatus.Complete)
        {
            var completion = await following;
            Assert.Equal(DelegatedResource, completion.ResourceId);
            Assert.Equal(generated, Assert.IsType<YieldJobResult.YieldJobDoneCase>(completion.Result).Value);
        }
        else
        {
            var error = await Assert.ThrowsAsync<JobError>(() => following);
            Assert.Equal(DelegatedJob, error.JobId);
            Assert.Equal(terminal == JobStatusResponseStatus.Failed ? "job.failed" : "job.cancelled", error.Code);
            if (terminal == JobStatusResponseStatus.Failed)
            {
                Assert.Equal("model refused", error.Message);
                Assert.Equal(FailureClass.Withheld, error.FailureClass);
            }
        }
    }

    [Fact]
    public async Task SetbackSupersedesAnInFlightStatusAndFollowingContinues()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new TestClock();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        await using var reader = client.Mark.Delegate(DelegatedResource, Highlighting()).GetAsyncEnumerator(deadline.Token);
        var first = reader.MoveNextAsync().AsTask();
        await AcceptDelegationAsync(server, deadline.Token);
        Assert.True(await first);
        await clock.WaitForAsync(JobSilence);
        clock.Advance(JobSilence);
        var stale = await ReadJobRequestAsync(server, BusOperations.JobStatusRequested.Request.Name, deadline.Token);

        client.Bus.Emit(BusChannels.JobFail, Setback(JobType.Mark));
        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<JobEvent<MarkJobCompleteCommand>.Failed>(reader.Current);
        Reply(server, stale, BusOperations.JobStatusRequested.Result.Name, JobStatus(DelegatedJob, JobStatusResponseStatus.Failed));
        clock.Advance(JobSilence + JobPoll);
        client.Bus.Emit(BusChannels.JobComplete, new JobCompleteCommand.MarkJobCompleteCommandCase(new MarkJobCompleteCommand
        {
            JobId = DelegatedJob,
            ResourceId = DelegatedResource,
        }));

        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<JobEvent<MarkJobCompleteCommand>.Complete>(reader.Current);
        Assert.False(await reader.MoveNextAsync());
        Assert.False(server.Emits.Reader.TryPeek(out _));
    }

    [Fact]
    public async Task YieldStallRestartsOnSetbackAndCancelsOnlyTheNamedJob()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new TestClock();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var stall = TimeSpan.FromMilliseconds(500);
        await using var reader = client.Yield.Delegate(GenerationParameters(), 500).GetAsyncEnumerator(deadline.Token);
        var first = reader.MoveNextAsync().AsTask();
        await clock.WaitForAsync(stall); // The deadline while awaiting job:create.
        await AcceptDelegationAsync(server, deadline.Token);
        Assert.True(await first);
        await clock.WaitForAsync(stall);
        clock.Advance(stall - TimeSpan.FromMilliseconds(1));

        client.Bus.Emit(BusChannels.JobFail, Setback(JobType.Yield));
        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<JobEvent<YieldJobCompleteCommand>.Failed>(reader.Current);
        await clock.WaitForAsync(stall);
        clock.Advance(stall);
        var cancel = await ReadJobRequestAsync(server, BusOperations.JobCancelRequested.Request.Name, deadline.Token);
        Reply(server, cancel, BusOperations.JobCancelRequested.Result.Name,
            new JobCancelResultBusEnvelope { Response = new JobCancelResult { Cancelled = true } });
        var error = await Assert.ThrowsAsync<JobError>(() => reader.MoveNextAsync().AsTask());
        Assert.Equal("job.stalled", error.Code);
        Assert.Equal(DelegatedJob, error.JobId);
        Assert.False(server.Emits.Reader.TryPeek(out _));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisposingTheReaderOrClosingTheClientEndsFollowing(bool close)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new TestClock();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        await using var reader = client.Mark.Delegate(DelegatedResource, Highlighting()).GetAsyncEnumerator(deadline.Token);
        var first = reader.MoveNextAsync().AsTask();
        await AcceptDelegationAsync(server, deadline.Token);
        Assert.True(await first);
        await clock.WaitForAsync(JobSilence);
        if (close)
        {
            client.Dispose();
            var error = await Assert.ThrowsAsync<BusRequestError>(() => reader.MoveNextAsync().AsTask());
            Assert.Equal("bus.closed", error.Code);
        }
        else
        {
            await reader.DisposeAsync();
            clock.Advance(JobSilence + JobPoll);
        }
        Assert.False(server.Emits.Reader.TryPeek(out _));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MarkRejectsAnotherVerbsCompletionFromEitherSource(bool fromStatus)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        var clock = new TestClock();
        using var client = new SemiontClient("http://unit.test", "token", http, clock);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var delegation = client.Mark.Delegate(DelegatedResource, Highlighting());
        async Task<MarkJobCompleteCommand> AwaitCompletionAsync() => await delegation;
        var following = AwaitCompletionAsync();
        await AcceptDelegationAsync(server, deadline.Token);

        if (fromStatus)
        {
            await clock.WaitForAsync(JobSilence);
            clock.Advance(JobSilence);
            var status = await ReadJobRequestAsync(server, BusOperations.JobStatusRequested.Request.Name, deadline.Token);
            var reply = JobStatus(DelegatedJob, JobStatusResponseStatus.Complete);
            Reply(server, status, BusOperations.JobStatusRequested.Result.Name, reply with { Response = reply.Response with { Type = JobType.Yield } });
        }
        else
        {
            PushJobFrame(server, BusChannels.JobComplete, new JobCompleteCommand.YieldJobCompleteCommandCase(new YieldJobCompleteCommand
            {
                JobId = DelegatedJob,
                ResourceId = DelegatedResource,
            }));
        }

        var error = await Assert.ThrowsAsync<TransportError>(() => following.WaitAsync(deadline.Token));
        Assert.Equal(ProtocolFacts.Error(0), error.Code);
    }

    private static void PushJobFrame<T>(Handler server, BusChannel<T> channel, T payload) where T : class =>
        server.Stream.Push("event: bus-event\ndata: " + JsonSerializer.Serialize(new { channel = channel.Name, payload }) + "\n\n");

    private static JobReportProgressCommand Progress(JobId id, JobType type, double percentage) => new()
    {
        JobId = id,
        JobType = type,
        ResourceId = DelegatedResource,
        Percentage = percentage,
        Progress = new JobProgress { Percentage = percentage },
    };

    private static JobFailCommand Setback(JobType type) => new()
    {
        JobId = DelegatedJob,
        JobType = type,
        ResourceId = DelegatedResource,
        WillRetry = true,
        Error = "retry",
    };

    private static MarkJobParams Highlighting() =>
        JsonSerializer.Deserialize<MarkJobParams>("""{"motivation":"highlighting"}""") ?? throw new InvalidOperationException("Missing mark params");

    private static GenerationJobParams GenerationParameters() => new()
    {
        Context = Required<GatheredContext>(SurfaceFixture("context")),
        Title = "Notes",
        StorageUri = "file://notes.md",
    };

    private static async Task AcceptDelegationAsync(Handler server, CancellationToken cancellation)
    {
        var (create, _) = await server.Emits.Reader.ReadAsync(cancellation);
        Assert.Equal(BusOperations.JobCreate.Request.Name, create.GetProperty("channel").GetString());
        AnswerCreate(server, create);
    }

    private static void AnswerCreate(Handler server, JsonElement create) =>
        Reply(server, create, BusOperations.JobCreate.Result.Name,
            new JobCreatedResult { Response = new JobCreatedResultResponse { JobId = DelegatedJob } });

    private static async Task<JsonElement> ReadJobRequestAsync(Handler server, string channel, CancellationToken cancellation)
    {
        var (request, _) = await server.Emits.Reader.ReadAsync(cancellation);
        Assert.Equal(channel, request.GetProperty("channel").GetString());
        Assert.Equal(DelegatedJob, request.GetProperty("payload").GetProperty("jobId").Deserialize<JobId>());
        return request;
    }
}
