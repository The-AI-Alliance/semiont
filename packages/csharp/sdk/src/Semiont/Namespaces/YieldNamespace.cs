using System.Text;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class YieldNamespace
{
    private readonly JobFollower follower;

    private readonly Bus wire;
    private readonly EventBus bus;
    private readonly HttpContentTransport content;

    internal YieldNamespace(JobFollower follower, Bus wire, EventBus bus, HttpContentTransport content)
    {
        this.follower = follower;
        this.wire = wire;
        this.bus = bus;
        this.content = content;
    }

    public Upload Resource(ResourceUpload data, CancellationToken cancellation = default) => new(content, data, cancellation);

    public async Task<CloneResourceWithTokenResponse> CloneTokenAsync(ResourceId resourceId, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.YieldCloneTokenRequested, new YieldCloneTokenRequest { ResourceId = resourceId },
            cancellation: cancellation).ConfigureAwait(false)).Response;

    public async Task<ResourceDescriptor> FromTokenAsync(string token, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.YieldCloneResourceRequested, new YieldCloneResourceRequest { Token = token },
            cancellation: cancellation).ConfigureAwait(false)).Response.SourceResource;

    public async Task<CreateResourceResponse> CreateFromTokenAsync(string token, string name, string text, bool? archiveOriginal = null,
        CancellationToken cancellation = default)
    {
        var source = await FromTokenAsync(token, cancellation).ConfigureAwait(false);
        var mediaType = MediaTypes.Primary(source);
        var format = MediaTypes.CloneFormat(mediaType);
        return await content.UploadAsync(new ResourceUpload
        {
            Name = name,
            File = Encoding.UTF8.GetBytes(text),
            Format = format,
            StorageUri = "file://" + MediaTypes.StorageFileName(name, format),
            CloneToken = token,
            ArchiveOriginal = archiveOriginal is bool archive ? archive ? "true" : "false" : null,
        }, null, cancellation).ConfigureAwait(false);
    }

    public void Clone() => bus.Emit(BusChannels.YieldClone, new EmptyBusPayload());

    /// <summary>Follows generation grounded in the supplied context. The stall deadline applies locally.</summary>
    public Delegation<YieldJobCompleteCommand> Delegate(GenerationJobParams parameters, int? stallDeadlineMs = null)
    {
        var resource = parameters.Context.Focus switch
        {
            GatheredContextFocus.ResourceCase(var focus) => focus.Resource.Id,
            GatheredContextFocus.AnnotationCase(var focus) => focus.SourceResource.Id,
        };
        var stall = stallDeadlineMs ?? GenerationStallMs(parameters.MaxTokens);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(stall);
        return follower.Follow(new JobCreateCommand.YieldJobCreateCommandCase(new YieldJobCreateCommand
        {
            Params = parameters,
        }), resource, JobCompletion.Yield, stall);
    }

    private static int GenerationStallMs(double? maxTokens)
    {
        var tokens = Math.Max(0, maxTokens ?? ProtocolFacts.Timing("generationStallAssumedTokensCount").GetInt32());
        var duration = Math.Round(tokens * ProtocolFacts.Timing("generationStallPerTokenMs").GetInt32(), MidpointRounding.AwayFromZero);
        if (!double.IsFinite(duration) || duration > int.MaxValue)
            throw new TransportError(ProtocolFacts.Error(0), "The generation's stall deadline cannot be represented.");
        return Math.Max(ProtocolFacts.Timing("generationStallFloorMs").GetInt32(), (int)duration);
    }
}
