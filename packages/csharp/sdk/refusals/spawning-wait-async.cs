// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Wait(System.Threading.Tasks.Task work, System.Threading.CancellationToken cancellation) => work.WaitAsync(cancellation);
}
