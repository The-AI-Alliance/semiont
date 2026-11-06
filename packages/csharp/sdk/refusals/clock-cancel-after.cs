// expect: SEM007
public static class Refusal
{
public static void Deadline(System.Threading.CancellationTokenSource source) => source.CancelAfter(1000);
}
