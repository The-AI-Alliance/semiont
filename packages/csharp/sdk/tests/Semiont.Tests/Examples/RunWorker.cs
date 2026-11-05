using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Semiont;
using Semiont.Http;
using Semiont.Jobs;
using Semiont.SignIn;
using Semiont.Types;

public static class RunWorker
{
    public static async Task RunAsync(HttpEndpoint endpoint, ServiceToken service,
        IReadOnlyList<JobFilter> filters, Func<IHeldJob, CancellationToken, Task> settle,
        bool commitsAnnotations = false, HttpClient? http = null,
        CancellationToken cancellation = default)
    {
        using var agent = new AgentToken(endpoint, service, http);
        await agent.SignInAsync(cancellation);

        var channels = commitsAnnotations
            ? WorkerRules.JobClaimChannels.Concat(WorkerRules.JobCommitChannels)
            : WorkerRules.JobClaimChannels;
        using var client = new SemiontClient(new HttpTransport(agent.Gateway, agent.Token,
            channels, refresher: agent.RefreshAsync, httpClient: http));
        using var updates = new CancellationTokenSource();
        var following = FollowTokensAsync(agent, client.Transport, updates.Token);
        var claims = client.Job.Claim(filters);
        try
        {
            while (await claims.NextAsync(cancellation) is { } job)
            {
                using var running = CancellationTokenSource.CreateLinkedTokenSource(cancellation, job.Cancelled);
                try
                {
                    await job.StartAsync(running.Token);
                    await settle(job, running.Token);
                    if (!job.Settled) throw new InvalidOperationException("The worker must settle its job.");
                }
                catch (OperationCanceledException) when (job.Cancelled.IsCancellationRequested && !cancellation.IsCancellationRequested)
                {
                    if (!job.Settled) await job.CancelAsync(cancellation: cancellation);
                }
            }
        }
        finally
        {
            try { await claims.StopAsync(); }
            finally
            {
                updates.Cancel();
                await following;
            }
        }
    }

    private static async Task FollowTokensAsync(AgentToken agent, HttpTransport transport, CancellationToken cancellation)
    {
        try
        {
            await foreach (var _ in agent.TokensChanged(cancellation)) transport.SetToken(agent.Token);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
    }
}
