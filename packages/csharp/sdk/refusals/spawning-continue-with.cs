// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Then(System.Threading.Tasks.Task work, System.Action<System.Threading.Tasks.Task> next) => work.ContinueWith(next, System.Threading.Tasks.TaskScheduler.Default);
}
