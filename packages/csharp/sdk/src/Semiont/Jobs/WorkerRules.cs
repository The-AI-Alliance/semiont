using System.Text.Json;
using Semiont.Types;

namespace Semiont.Jobs;

public static class WorkerRules
{
    public static readonly IReadOnlyList<string> JobClaimChannels = Array.AsReadOnly(new[]
    {
        BusOperations.JobClaim.Result.Name, BusOperations.JobClaim.Failure.Name,
        BusChannels.JobQueued.Name, BusChannels.JobCancelRequested.Name,
    });

    public static readonly IReadOnlyList<string> JobCommitChannels = Array.AsReadOnly(new[]
    {
        BusOperations.MarkCommit.Result.Name, BusOperations.MarkCommit.Failure.Name,
        BusOperations.BrowseAnnotationRequested.Result.Name, BusOperations.BrowseAnnotationRequested.Failure.Name,
    });

    public static bool JobMatchesFilter(JsonElement filter, JsonElement job) => filter.ValueKind == JsonValueKind.Object
        ? job.ValueKind == JsonValueKind.Object && filter.EnumerateObject().All(field =>
            job.TryGetProperty(field.Name, out var actual) && JobMatchesFilter(field.Value, actual))
        : JsonElement.DeepEquals(filter, job);

    public static bool WillRetryAfter(long retryCount, long maxRetries, FailureClass? failureClass) =>
        retryCount < maxRetries && failureClass is null or FailureClass.Transient;
}
