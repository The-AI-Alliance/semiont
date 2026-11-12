using System.Text.Json;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Jobs;
using Semiont.Protocol;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Fact]
    public void JobFiltersAnswerTheSharedCases()
    {
        using var table = ReadSpec("jobs/filter-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
            Assert.Equal(row.GetProperty("matches").GetBoolean(),
                WorkerRules.JobMatchesFilter(row.GetProperty("filter"), row.GetProperty("job")));
    }

    [Fact]
    public void WorkerRetriesAnswerTheSharedCases()
    {
        using var table = ReadSpec("jobs/retry-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            var failureClass = row.TryGetProperty("failureClass", out var kind) ? kind.Deserialize<FailureClass>() : (FailureClass?)null;
            Assert.Equal(row.GetProperty("retries").GetBoolean(),
                WorkerRules.WillRetryAfter(row.GetProperty("retryCount").GetInt64(), row.GetProperty("maxRetries").GetInt64(), failureClass));
        }
    }

    [Fact]
    public async Task StopSettlesAClaimThatArrivesAfterTheWorkerStops()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var row = SurfaceMethod("job", "claim");
        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var filters = Required<JobFilter[]>(example.GetProperty("args").GetProperty("options").GetProperty("accepts"));
            var worker = client.Job.Claim(filters);
            Assert.False(server.Emits.Reader.TryPeek(out _));
            var next = worker.NextAsync(deadline.Token);
            var (claim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(Text(row.GetProperty("via"), "request"), Text(claim, "channel"));
            Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), claim.GetProperty("payload")));

            var stop = worker.StopAsync();
            Assert.False(stop.IsCompleted);
            Assert.Null(await next);
            Reply(server, claim, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
            var (failure, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(BusChannels.JobFail.Name, Text(failure, "channel"));
            Assert.False(failure.TryGetProperty("scope", out _));
            var command = Required<JobFailCommand>(failure.GetProperty("payload"));
            Assert.Equal(DelegatedJob, command.JobId);
            Assert.True(command.WillRetry);
            Assert.Null(command.FailureClass);
            await stop.WaitAsync(deadline.Token);
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }
    }

    [Fact]
    public async Task AWorkerCannotSettleTheSameJobTwice()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var filters = Required<JobFilter[]>(JsonSerializer.SerializeToElement(new[] { new { jobType = "mark", @params = new { motivation = "highlighting" } } }));
        var worker = client.Job.Claim(filters);
        var next = worker.NextAsync(deadline.Token);
        var (first, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Reply(server, first, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
        var job = Assert.IsType<HeldMarkJob>(await next);

        var result = new MarkJobResult.MarkJobDoneCase(new MarkJobDone { Found = 3, Persisted = 2 });
        var completed = job.CompleteAsync(result, deadline.Token);
        var refused = job.FailAsync("late failure", cancellation: deadline.Token);
        await completed;
        await Assert.ThrowsAsync<InvalidOperationException>(() => refused);
        Assert.True(job.Settled);
        Assert.Equal(1, worker.Vitals().JobsCompleted);

        var (completion, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusChannels.JobComplete.Name, Text(completion, "channel"));
        var (nextClaim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(nextClaim, "channel"));
        Reply(server, nextClaim, BusOperations.JobClaim.Failure.Name, new { message = "No work", code = "none-pending" });
        await worker.StopAsync().WaitAsync(deadline.Token);
        Assert.False(server.Emits.Reader.TryPeek(out _));
    }

    [Fact]
    public async Task AYieldWorkerNamesItsAnchorInLifecycleAndCompletion()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var filters = Required<JobFilter[]>(JsonSerializer.SerializeToElement(new[] { new { jobType = "yield" } }));
        var worker = client.Job.Claim(filters);
        var next = worker.NextAsync(deadline.Token);
        var (claim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        using var examples = ReadSpec("annotations/reader-cases.json");
        var annotation = Required<Annotation>(examples.RootElement.GetProperty("cases")[0].GetProperty("annotation"));
        var context = GenerationParameters().Context with
        {
            Focus = new GatheredContextFocus.AnnotationCase(new GatheredContextFocusAnnotation
            {
                Annotation = annotation,
                SourceResource = SourceResource(),
            }),
        };
        var mark = RunningMarkJob();
        Reply(server, claim, BusOperations.JobClaim.Result.Name, new JobClaimedResult
        {
            Response = mark with
            {
                Metadata = mark.Metadata with { Type = JobType.Yield },
                Params = new JobParams
                {
                    ResourceId = DelegatedResource,
                    AdditionalProperties = new Dictionary<string, JsonElement> { ["context"] = JsonSerializer.SerializeToElement(context) },
                },
            },
        });
        var job = Assert.IsType<HeldYieldJob>(await next);
        Assert.Equal(annotation.Id, job.AnnotationId);

        await job.StartAsync(deadline.Token);
        var start = await ReadJobRequestAsync(server, BusChannels.JobStart.Name, deadline.Token);
        Assert.Equal(annotation.Id, Required<JobStartCommand>(start.GetProperty("payload")).AnnotationId);
        await job.ProgressAsync(new JobProgress { Percentage = 50 }, deadline.Token);
        var progress = await ReadJobRequestAsync(server, BusChannels.JobReportProgress.Name, deadline.Token);
        var report = Required<JobReportProgressCommand>(progress.GetProperty("payload"));
        Assert.Equal(annotation.Id, report.AnnotationId);
        Assert.Equal(annotation.Id, report.Progress?.AnnotationId);

        await job.CompleteAsync(new YieldJobResult.YieldJobDoneCase(new YieldJobDone
        {
            ResourceId = ResourceId.Parse("res-2"),
            ResourceName = "Generated",
            Truncated = false,
        }), deadline.Token);
        var completed = await ReadJobRequestAsync(server, BusChannels.JobComplete.Name, deadline.Token);
        Assert.Equal(annotation.Id, Required<YieldJobCompleteCommand>(completed.GetProperty("payload")).AnnotationId);
        var (nextClaim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Reply(server, nextClaim, BusOperations.JobClaim.Failure.Name, new { message = "No work", code = "none-pending" });
        await worker.StopAsync().WaitAsync(deadline.Token);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationAtClaimHandoverIsRoutedInReceiveOrder(bool afterReply)
    {
        var acknowledged = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var server = new Handler
        {
            BeforeEmitReply = (body, cancellation) => Text(body, "channel") == BusOperations.JobClaim.Request.Name
                ? acknowledged.Task.WaitAsync(cancellation) : Task.CompletedTask,
        };
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var example = SurfaceMethod("job", "claim").GetProperty("cases")[0];
        var worker = client.Job.Claim(Required<JobFilter[]>(example.GetProperty("sends").GetProperty("accepts")));
        var next = worker.NextAsync(deadline.Token);
        var (claim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);

        var job = RunningMarkJob();
        void Answer() => Reply(server, claim, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = job });
        if (afterReply) Answer();
        PushJobFrame(server, BusChannels.JobCancelRequested, new JobCancelRequest { JobId = DelegatedJob });
        if (!afterReply) Answer();
        PushJobFrame(server, BusChannels.JobQueued, new JobQueuedEvent.MarkJobQueuedEventCase(new MarkJobQueuedEvent
        {
            JobId = JobId.Parse("other-job"),
            ResourceId = DelegatedResource,
            UserId = job.Metadata.UserId,
            Params = Highlighting(),
        }));
        while (worker.Vitals().LastQueuedEventAt is null) await Task.Delay(1, deadline.Token);

        acknowledged.SetResult();
        var held = Assert.IsType<HeldMarkJob>(await next);
        Assert.Equal(afterReply, held.Cancelled.IsCancellationRequested);
        await worker.StopAsync().WaitAsync(deadline.Token);
    }

    [Fact]
    public async Task ARefusedAnnouncementIsHeardAndClaimsAsAMatchingOneDoes()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var worker = client.Job.Claim(HighlightingFilters());
        var next = worker.NextAsync(deadline.Token);
        var (first, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Reply(server, first, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });
        Assert.Null(worker.Vitals().LastQueuedEventAt);

        // No filter can be compared with what cannot be read.
        PushRawFrame(server, BusChannels.JobQueued.Name, "job-8");
        var (second, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(second, "channel"));
        Assert.NotNull(worker.Vitals().LastQueuedEventAt);
        Reply(server, second, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
        Assert.Equal(DelegatedJob, Assert.IsType<HeldMarkJob>(await next).JobId);
        await worker.StopAsync().WaitAsync(deadline.Token);
    }

    [Fact]
    public async Task ARefusedAnnouncementWhileAClaimIsInFlightEarnsOneMoreClaim()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var worker = client.Job.Claim(HighlightingFilters());
        var next = worker.NextAsync(deadline.Token);
        var (first, _) = await server.Emits.Reader.ReadAsync(deadline.Token);

        PushRawFrame(server, BusChannels.JobQueued.Name, "job-9");
        while (worker.Vitals().LastQueuedEventAt is null) await Task.Delay(1, deadline.Token);
        Assert.False(server.Emits.Reader.TryPeek(out _), "one claim is in flight at a time");
        Reply(server, first, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });
        var (second, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(second, "channel"));
        Reply(server, second, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });
        await worker.StopAsync().WaitAsync(deadline.Token);
        Assert.Null(await next);
        Assert.False(server.Emits.Reader.TryPeek(out _), "and exactly one");
    }

    [Fact]
    public async Task ARefusedAnnouncementWhileAJobIsHeldIsHeardAndIgnored()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var worker = client.Job.Claim(HighlightingFilters());
        var next = worker.NextAsync(deadline.Token);
        var (first, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Reply(server, first, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
        var job = Assert.IsType<HeldMarkJob>(await next);

        PushRawFrame(server, BusChannels.JobQueued.Name, "job-8");
        while (worker.Vitals().LastQueuedEventAt is null) await Task.Delay(1, deadline.Token);
        Assert.False(server.Emits.Reader.TryPeek(out _));
        await job.CompleteAsync(new MarkJobResult.MarkJobDoneCase(new MarkJobDone { Found = 0, Persisted = 0 }), deadline.Token);
        var (completion, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusChannels.JobComplete.Name, Text(completion, "channel"));
        var (settled, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(settled, "channel"));
        Reply(server, settled, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });
        await worker.StopAsync().WaitAsync(deadline.Token);
        Assert.False(server.Emits.Reader.TryPeek(out _), "the settle claims, and nothing was owed");
    }

    // Of the claims refused before anyone reads the refusals, the latest errorsKeptForFirstReaderCount
    // (protocol/specs/src/client/timing.json) are kept, the oldest dropped beyond that: the first reader hears those, in
    // the order refused.
    [Fact]
    public async Task TheFirstReaderOfRefusalsNobodyReadHearsTheLatestInOrder()
    {
        var most = ProtocolFacts.Timing("errorsKeptForFirstReaderCount").GetInt32();
        var details = Enumerable.Range(0, most + 3).Select(at => $"refusal {at}").ToArray();
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http);
        using var client = new SemiontClient(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);
        var worker = client.Job.Claim(HighlightingFilters());
        var next = worker.NextAsync(deadline.Token);
        foreach (var detail in details)
        {
            var (claim, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(BusOperations.JobClaim.Request.Name, Text(claim, "channel"));
            Reply(server, claim, BusOperations.JobClaim.Failure.Name, new { message = detail, code = "unauthorized" });
            PushRawFrame(server, BusChannels.JobQueued.Name, "job-8");
        }
        // A claim is made only once the one before it has said its refusal, so by this one each has been said.
        var (last, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
        Reply(server, last, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });

        await using var refused = worker.Refused(deadline.Token).GetAsyncEnumerator();
        var told = refused.MoveNextAsync().AsTask();
        await worker.StopAsync().WaitAsync(deadline.Token);
        var heard = new List<string>();
        while (await told.WaitAsync(deadline.Token))
        {
            heard.Add(refused.Current.Detail);
            told = refused.MoveNextAsync().AsTask();
        }
        Assert.Equal(details.TakeLast(most), heard);
        Assert.Null(await next);
    }

    // Of the stalls found before anyone reads them, the latest errorsKeptForFirstReaderCount
    // (protocol/specs/src/client/timing.json) are kept, the oldest dropped beyond that: the first reader hears those, in
    // the order found. A held job stalls once, so each stall is another job's. The case runs on one thread, its clock
    // moving only here, so once what a pass made ready has run, the job's stall has been found, before it is settled.
    [Fact]
    public async Task TheFirstReaderOfStallsNobodyReadHearsTheLatestInOrder()
    {
        var most = ProtocolFacts.Timing("errorsKeptForFirstReaderCount").GetInt32();
        var quiet = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("heldJobStallMs").GetInt32() + ProtocolFacts.Timing("heldJobStallCheckMs").GetInt32());
        await CaseContext.PlayAsync(async context =>
        {
            var clock = new StateCaseClock(DateTimeOffset.UnixEpoch);
            using var server = new Handler();
            using var http = new HttpClient(server);
            using var transport = new HttpTransport("http://unit.test", "token", WorkerRules.JobClaimChannels, httpClient: http, timeProvider: clock);
            using var client = new SemiontClient(transport);
            await OpenAsync(transport);
            var worker = client.Job.Claim(HighlightingFilters());
            var claimedAt = new List<DateTimeOffset>();
            for (var at = 0; at < most + 3; at++)
            {
                var next = worker.NextAsync();
                var (claim, _) = await server.Emits.Reader.ReadAsync();
                Reply(server, claim, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
                var job = Assert.IsType<HeldMarkJob>(await next);
                claimedAt.Add(clock.GetUtcNow());
                // Past the stall threshold by one look: the first look past it finds the job stalled.
                var until = clock.GetTimestamp() + quiet.Ticks;
                while (clock.FireNext(until)) await context.DrainAsync();
                await context.DrainAsync();
                await job.CompleteAsync(new MarkJobResult.MarkJobDoneCase(new MarkJobDone { Found = 0, Persisted = 0 }));
                var (completion, _) = await server.Emits.Reader.ReadAsync();
                Assert.Equal(BusChannels.JobComplete.Name, Text(completion, "channel"));
            }
            var (last, _) = await server.Emits.Reader.ReadAsync();
            Reply(server, last, BusOperations.JobClaim.Failure.Name, new { message = "No pending job matches", code = "none-pending" });
            await context.DrainAsync();

            await using var stalls = worker.Stalled().GetAsyncEnumerator();
            var told = stalls.MoveNextAsync().AsTask();
            await worker.StopAsync();
            var heard = new List<DateTimeOffset>();
            while (await told)
            {
                heard.Add(stalls.Current.HeldSince);
                told = stalls.MoveNextAsync().AsTask();
            }
            Assert.Equal(claimedAt.TakeLast(most), heard);
        });
    }

    private static JobFilter[] HighlightingFilters() =>
        Required<JobFilter[]>(JsonSerializer.SerializeToElement(new[] { new { jobType = "mark", @params = new { motivation = "highlighting" } } }));

    private static JobRunning RunningMarkJob() => Required<JobRunning>(JsonSerializer.Deserialize<JsonElement>("""
        {"status":"running","metadata":{"id":"job-1","type":"mark","userId":"did:web:example.org:users:alice","created":"2026-01-01T00:00:00Z","retryCount":0,"maxRetries":3},"params":{"resourceId":"res-1","motivation":"highlighting"},"startedAt":"2026-01-01T00:00:01Z","progress":{}}
        """));
}
