// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Turn(System.Threading.SemaphoreSlim turn, System.Threading.CancellationToken cancellation) => turn.WaitAsync(cancellation);
}
