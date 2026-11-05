using System.Text.Json;
using Semiont.SignIn;
using Semiont.Types;
using Microsoft.Extensions.Time.Testing;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Globalization;
using Xunit;

namespace Semiont.Tests;

public sealed class SignInStoreTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EveryRenewalRaceRuns(bool disk)
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/sign-in-store/cases.json")));
        var directory = Path.Combine(Path.GetTempPath(), "semiont store " + Guid.NewGuid());
        var clock = new FakeTimeProvider(DateTimeOffset.FromUnixTimeSeconds(2000000000));
        try
        {
            foreach (var row in table.RootElement.GetProperty("renewals").EnumerateArray())
            {
                var expired = row.GetProperty("expired").EnumerateArray().Select(value => value.GetString()).ToHashSet();
                string? Access(JsonElement value) => value.ValueKind == JsonValueKind.Null ? null : TokenTests.Jwt(new
                {
                    iss = "https://issuer.example",
                    email = "alice@example.com",
                    name = value.GetString(),
                    exp = clock.GetUtcNow().ToUnixTimeSeconds() + (expired.Contains(value.GetString()) ? -3600 : 3600),
                });
                StoredSession Stored(JsonElement value) => new()
                {
                    Access = Access(value.GetProperty("token")) ?? throw new InvalidOperationException("Missing token"),
                    Refresh = value.GetProperty("refreshToken").GetString() ?? throw new InvalidOperationException("Missing refresh"),
                    ClientId = SignInPolicy.ScriptClientId,
                    TokenEndpoint = "https://issuer.example/token",
                };
                ISignInKept kept = disk ? new SignInStore(directory).Entry("stack") : new MemorySignIn();
                await kept.KeepAsync(Stored(row.GetProperty("kept")));
                var meanwhile = row.GetProperty("meanwhile");
                async Task OtherAsync(string when)
                {
                    if (meanwhile.ValueKind == JsonValueKind.Null || meanwhile.GetProperty("when").GetString() != when) return;
                    if (meanwhile.GetProperty("does").GetString() == "signs-out") await kept.ForgetAsync();
                    else await kept.KeepAsync(Stored(meanwhile.GetProperty("theirs")));
                }
                await OtherAsync("before");
                var grants = 0;
                string? spent = null;
                var given = await KeptRenewal.RenewAsync(kept, Access(row.GetProperty("holding")), async (read, cancellation) =>
                {
                    cancellation.ThrowIfCancellationRequested();
                    grants++;
                    spent = read.Refresh;
                    await OtherAsync("during");
                    var issues = row.GetProperty("issues");
                    return (Access(issues.GetProperty("token")) ?? throw new InvalidOperationException("Missing issued token"),
                        issues.TryGetProperty("refreshToken", out var refresh) ? refresh.GetString() : null);
                }, clock);
                var expectedSpent = row.GetProperty("spends");
                Assert.Equal(expectedSpent.ValueKind == JsonValueKind.Null ? null : expectedSpent.GetString(), spent);
                Assert.Equal(expectedSpent.ValueKind == JsonValueKind.Null ? 0 : 1, grants);
                Assert.Equal(Access(row.GetProperty("gives")), given);
                var leaves = row.GetProperty("leaves");
                Assert.Equal(leaves.ValueKind == JsonValueKind.Null ? null : Stored(leaves), await kept.HeldAsync());
            }
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task RenewalPreservesOtherEntriesAndLearnedFields()
    {
        var directory = Path.Combine(Path.GetTempPath(), "semiont store " + Guid.NewGuid());
        try
        {
            var store = new SignInStore(directory);
            var entry = store.Entry("stack");
            var original = new StoredSession
            {
                Access = TokenTests.Jwt(new { iss = "https://issuer.example", email = "alice@example.com", exp = 2000000000 }),
                Refresh = "refresh-1",
                ClientId = SignInPolicy.ScriptClientId,
                TokenEndpoint = "https://issuer.example/token",
                RevocationEndpoint = "https://issuer.example/revoke",
            };
            await entry.KeepAsync(original);
            await store.ChangeAsync(document =>
            {
                document["other"] = new JsonObject { ["future"] = 42 };
                document["stack"]?.AsObject().Add("future", new JsonArray("preserve", 7));
                return true;
            });
            var before = await store.ReadAsync();
            await entry.RenewedAsync(original, TokenTests.Jwt(new { iss = "https://issuer.example", exp = 2000003600 }), "refresh-2");
            var after = await store.ReadAsync();
            Assert.True(JsonNode.DeepEquals(before["other"], after["other"]));
            foreach (var name in new[] { "future", "email", "issuer", "tokenEndpoint", "revocationEndpoint" })
                Assert.True(JsonNode.DeepEquals(before["stack"]?[name], after["stack"]?[name]), name);
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(StorePermissions.DirectoryMode, File.GetUnixFileMode(directory));
                Assert.Equal(StorePermissions.FileMode, File.GetUnixFileMode(store.FilePath));
            }
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task ContendingWriterCanCancelWithoutChangingTheStore()
    {
        var directory = Path.Combine(Path.GetTempPath(), "semiont store " + Guid.NewGuid());
        try
        {
            var store = new SignInStore(directory);
            await store.ChangeAsync(document => { document["value"] = 1; return true; });
            using (await NativeStoreLock.HoldAsync(Path.Combine(directory, Semiont.Protocol.ProtocolTables.StoreLockName),
                StorePermissions.FileMode, TimeProvider.System, Random.Shared, CancellationToken.None))
            {
                using var cancellation = new CancellationTokenSource();
                var change = store.ChangeAsync(document => { document["value"] = 2; return true; }, cancellation.Token);
                if (change.IsCompleted) await change;
                Assert.False(change.IsCompleted);
                cancellation.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => change);
                Assert.Equal(1, (await store.ReadAsync())["value"]?.GetValue<int>());
            }
            await store.ChangeAsync(document => { document["value"] = 3; return true; });
            Assert.Equal(3, (await store.ReadAsync())["value"]?.GetValue<int>());
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    // How long the process holding the lock may take to start and say so. A
    // cold Windows PowerShell on a loaded runner has taken more than ten
    // seconds; the store's own waits keep their ten.
    private static readonly TimeSpan LockHolderStart = TimeSpan.FromSeconds(60);

    [Fact]
    public async Task StoreWaitsForAnIndependentProcessLock()
    {
        var directory = Path.Combine(Path.GetTempPath(), "semiont store " + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, Semiont.Protocol.ProtocolTables.StoreLockName);
        await File.WriteAllTextAsync(path, "");
        var start = new ProcessStartInfo
        {
            FileName = OperatingSystem.IsWindows() ? "powershell.exe" : OperatingSystem.IsMacOS() ? "/usr/bin/perl" : "flock",
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        if (OperatingSystem.IsWindows())
        {
            // Windows PowerShell is given no PSModulePath: the one PowerShell 7
            // sets, which a CI step's shell hands down, leads it to modules it
            // cannot load.
            start.Environment.Remove("PSModulePath");
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-Command");
            // FileStream.Lock uses the Windows byte-range lock, independently of the SDK's P/Invoke.
            var offset = ((long)Semiont.Protocol.ProtocolTables.WindowsOffsetHigh << 32).ToString(CultureInfo.InvariantCulture);
            start.ArgumentList.Add("$f = [IO.File]::Open('" + path.Replace("'", "''", StringComparison.Ordinal) + "', 'Open', 'ReadWrite', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); $f.Lock([long]" + offset + ", 1); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()");
        }
        else if (OperatingSystem.IsMacOS())
        {
            start.ArgumentList.Add("-e");
            start.ArgumentList.Add("open my $f, '+<', $ARGV[0] or die $!; flock($f, 2) or die $!; $| = 1; print qq(ready\\n); <STDIN>;");
            start.ArgumentList.Add(path);
        }
        else
        {
            start.ArgumentList.Add("--exclusive");
            start.ArgumentList.Add(path);
            start.ArgumentList.Add("sh");
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("echo ready; read release");
        }
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start lock holder");
        try
        {
            Assert.Equal("ready", await process.StandardOutput.ReadLineAsync().WaitAsync(LockHolderStart));
            var store = new SignInStore(directory);
            var change = store.ChangeAsync(document => { document["written"] = true; return true; });
            if (change.IsCompleted) await change;
            Assert.False(change.IsCompleted);
            await process.StandardInput.WriteLineAsync("release");
            await process.StandardInput.FlushAsync();
            await change.WaitAsync(TimeSpan.FromSeconds(10));
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(0, process.ExitCode);
            Assert.True((await store.ReadAsync())["written"]?.GetValue<bool>());
        }
        finally
        {
            if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void EveryStateDirectoryCaseRuns()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/sign-in-store/cases.json")));
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
        {
            string? Value(string name) => row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            Assert.Equal(Value("dir"), SignInStore.StateDirectory(Value("os") ?? throw new InvalidOperationException("No OS"), Value("home"), Value("xdgStateHome"), Value("localAppData")));
        }
    }
}
