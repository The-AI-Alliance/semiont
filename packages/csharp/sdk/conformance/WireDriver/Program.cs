using Semiont.Errors;
using OpenTelemetry;
using OpenTelemetry.Trace;
using OpenTelemetry.Metrics;
using OpenTelemetry.Exporter;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;

using var traces = Sdk.CreateTracerProviderBuilder().AddSource("semiont").AddOtlpExporter(options => options.Protocol = OtlpExportProtocol.HttpProtobuf).Build();
using var metrics = Sdk.CreateMeterProviderBuilder().AddMeter("semiont").AddOtlpExporter(options => options.Protocol = OtlpExportProtocol.HttpProtobuf).Build();
var driver = new WireDriver();
using var live = args.Contains("--live", StringComparer.Ordinal) ? new LiveDriver() : null;
WireDriver.Say(new { ready = true });
var operations = new List<Task>();
while (await Console.In.ReadLineAsync() is string line)
{
    using var document = JsonDocument.Parse(line);
    var command = document.RootElement.Clone();
    operations.Add(live is null ? driver.RunAsync(command) : live.RunAsync(command));
}
live?.Dispose();
driver.Dispose();
await Task.WhenAll(operations);

internal sealed class WireDriver : IDisposable
{
    private static readonly object Output = new();
    private static readonly JsonSerializerOptions Json = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private readonly object gate = new();
    private readonly Dictionary<long, CancellationTokenSource> callers = [];
    private readonly Dictionary<string, Stack<IDisposable>> holds = [];
    private HttpTransport? transport;
    private ConnectionState? reportedState;

    internal static void Say<T>(T value) { lock (Output) { Console.WriteLine(JsonSerializer.Serialize(value, Json)); } }
    private static string Text(JsonElement args, string name) => args.GetProperty(name).GetString() ?? throw new InvalidOperationException(name + " is null");
    private HttpTransport Current => transport ?? throw new InvalidOperationException("No transport is open");

    internal async Task RunAsync(JsonElement args)
    {
        var id = args.GetProperty("id").GetInt64();
        var op = Text(args, "op");
        using var cancellation = new CancellationTokenSource();
        lock (gate) { callers.Add(id, cancellation); }
        try
        {
            object? answer = null;
            switch (op)
            {
                case "open":
                    if (transport is not null) throw new InvalidOperationException("A transport is already open");
                    var timing = args.TryGetProperty("timing", out var values)
                        ? JsonSerializer.Deserialize<Timing>(values.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow }) ?? throw new InvalidOperationException("Null timing") : new Timing();
                    var renewals = args.TryGetProperty("renewals", out var tokens)
                        ? new Queue<string>(tokens.EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("Null renewal"))) : null;
                    transport = new HttpTransport(Text(args, "baseUrl"), Text(args, "token"),
                        args.GetProperty("channels").EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("Null channel")), timing,
                        renewals is null ? null : (_, _) => Task.FromResult(renewals.TryDequeue(out var token) ? token : null));
                    _ = ReportStatesAsync(transport);
                    _ = ReportErrorsAsync(transport);
                    break;
                case "close": Current.Dispose(); break;
                case "set-token": Current.SetToken(Text(args, "token")); break;
                case "sync": ReportState(Current.State); break;
                case "listen": _ = ReportFramesAsync(Current, Text(args, "channel")); break;
                case "subscribe-resource":
                    var resource = Text(args, "resource");
                    var held = Current.SubscribeToResource(ResourceId.Parse(resource));
                    if (!holds.TryGetValue(resource, out var stack)) { stack = new(); holds.Add(resource, stack); }
                    stack.Push(held);
                    break;
                case "release-resource":
                    var released = Text(args, "resource");
                    if (!holds.TryGetValue(released, out var heldStack) || heldStack.Count == 0) throw new InvalidOperationException("No hold on " + released);
                    heldStack.Pop().Dispose();
                    break;
                case "emit":
                    var count = await Current.EmitAsync(Text(args, "channel"), args.GetProperty("payload"),
                        args.TryGetProperty("scope", out var scope) ? ResourceId.Parse(scope.GetString() ?? throw new InvalidOperationException("Null scope")) : null,
                        args.TryGetProperty("correlationId", out var correlation) ? correlation.GetString() : null, cancellation.Token);
                    answer = count is long subscribers ? new { subscribers } : (object)new { };
                    break;
                case "request":
                    var response = await Current.RequestAsync(Text(args, "operation"), args.GetProperty("payload"), args.GetProperty("timeoutMs").GetInt32(), cancellation.Token);
                    answer = response is JsonElement payload ? new { response = payload } : (object)new { };
                    break;
                case "health": answer = await Current.HealthCheckAsync(cancellation.Token); break;
                case "status": answer = await Current.GetStatusAsync(cancellation.Token); break;
                case "current-user": answer = await Current.GetCurrentUserAsync(cancellation.Token); break;
                case "protected-resource-metadata": answer = await Current.GetProtectedResourceMetadataAsync(cancellation.Token); break;
                case "media-token": answer = await Current.GetMediaTokenAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token); break;
                case "graph": answer = await new HttpContentTransport(Current).GetResourceGraphAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token); break;
                case "annotations": answer = await new HttpContentTransport(Current).GetAnnotationsAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token); break;
                case "anchored-text": answer = JsonSerializer.SerializeToNode(await new HttpContentTransport(Current).GetAnchoredTextAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token)); break;
                case "put":
                case "upload":
                    var upload = JsonNode.Parse(args.GetRawText())?.AsObject() ?? throw new InvalidOperationException("Null upload");
                    upload["file"] = upload["bytes"]?.DeepClone();
                    upload.Remove("bytes");
                    upload.Remove("id");
                    upload.Remove("op");
                    foreach (var field in new[] { "entityTypes", "isDraft" })
                    {
                        if (upload[field] is JsonNode value) upload[field] = value.ToJsonString();
                    }
                    var request = upload.Deserialize<ResourceUpload>() ?? throw new InvalidOperationException("Null upload request");
                    var resourceId = await new HttpContentTransport(Current).PutBinaryAsync(request, op == "upload" ? new UploadReporter(id) : null, cancellation.Token);
                    answer = new { resourceId = resourceId.Value };
                    break;
                case "get-stream":
                    using (var read = await new HttpContentTransport(Current).GetBinaryStreamAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token))
                    using (var destination = new MemoryStream())
                    {
                        await read.Stream.CopyToAsync(destination, cancellation.Token);
                        answer = new { contentType = read.ContentType, bytes = Convert.ToBase64String(destination.ToArray()) };
                    }
                    break;
                case "get":
                    var content = new HttpContentTransport(Current);
                    var bytes = await content.GetBinaryAsync(ResourceId.Parse(Text(args, "resource")), cancellation.Token);
                    answer = new { contentType = bytes.ContentType, bytes = Convert.ToBase64String(bytes.Bytes) };
                    break;
                case "abandon":
                    lock (gate)
                    {
                        if (!callers.TryGetValue(args.GetProperty("request").GetInt64(), out var caller)) throw new InvalidOperationException("No such request");
                        caller.Cancel();
                    }
                    break;
                default:
                    Say(new { id, unsupported = true });
                    return;
            }
            Say(new JsonObject { ["id"] = id, ["ok"] = JsonSerializer.SerializeToNode(answer, Json) });
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { Say(new { id, abandoned = true }); }
        catch (SemiontError error) { Say(new { id, error = Failure(error) }); }
        catch (Exception error) { Say(new { id, misuse = error.Message }); }
        finally { lock (gate) { callers.Remove(id); } }
    }

    private static object Failure(SemiontError error) => new { code = error.Code, status = error.Status, detail = error.Message };

    private async Task ReportStatesAsync(HttpTransport transport)
    {
        await foreach (var state in transport.States()) ReportState(state);
    }

    private void ReportState(ConnectionState value)
    {
        lock (gate)
        {
            if (reportedState == value) return;
            reportedState = value;
            Say(new { state = value.ToString().ToLowerInvariant() });
        }
    }

    private static async Task ReportErrorsAsync(HttpTransport transport)
    {
        await foreach (var error in transport.Errors()) Say(new { error = Failure(error) });
    }

    private static async Task ReportFramesAsync(HttpTransport transport, string channel)
    {
        await foreach (var frame in transport.Frames(channel))
        {
            Say(new { frame });
        }
    }

    private sealed class UploadReporter(long id) : IProgress<UploadProgress>
    {
        public void Report(UploadProgress value) => Say(new { progress = new { upload = id, bytesUploaded = value.BytesUploaded, totalBytes = value.TotalBytes } });
    }

    public void Dispose() => transport?.Dispose();
}
