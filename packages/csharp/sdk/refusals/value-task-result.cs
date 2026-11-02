// expect: SEM002
public static class Refusal
{
public static int Read(System.Threading.Tasks.ValueTask<int> task) => task.Result;
}
