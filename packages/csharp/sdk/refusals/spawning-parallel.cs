// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Each(int[] items, System.Func<int, System.Threading.CancellationToken, System.Threading.Tasks.ValueTask> body) => System.Threading.Tasks.Parallel.ForEachAsync(items, body);
}
