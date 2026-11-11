// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static async System.Threading.Tasks.Task Read(System.Collections.Generic.IAsyncEnumerable<int> items) { await foreach (var item in items) { } }
}
