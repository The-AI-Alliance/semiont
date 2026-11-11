// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Start(System.Func<System.Threading.Tasks.Task> work) => System.Threading.Tasks.Task.Run(work);
}
