// expect: SEM002
public static class Refusal
{
public static void Read(System.Threading.Tasks.Task task) => task.Wait();
}
