// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Start(System.Action work) => System.Threading.Tasks.Task.Factory.StartNew(work, System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.DenyChildAttach, System.Threading.Tasks.TaskScheduler.Default);
}
