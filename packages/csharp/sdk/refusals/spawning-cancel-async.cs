// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Cancel(System.Threading.CancellationTokenSource source) => source.CancelAsync();
}
