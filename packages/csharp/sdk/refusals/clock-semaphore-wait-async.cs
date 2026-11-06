// expect: SEM007
public static class Refusal
{
public static System.Threading.Tasks.Task<bool> Wait(System.Threading.SemaphoreSlim turn) => turn.WaitAsync(1000);
}
