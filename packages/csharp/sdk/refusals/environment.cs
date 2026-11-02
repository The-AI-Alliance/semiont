// expect: SEM005
public static class Refusal
{
public static string? Read() => System.Environment.GetEnvironmentVariable("HOME");
}
