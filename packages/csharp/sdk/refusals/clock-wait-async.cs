// expect: SEM007
public static class Refusal
{
public static System.Threading.Tasks.Task Wait(System.Threading.Tasks.Task work) => work.WaitAsync(System.TimeSpan.FromSeconds(1));
}
