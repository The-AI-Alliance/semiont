// expect: SEM005
public static class Refusal
{
public static string? Read(string key) => System.Environment.GetEnvironmentVariable(key);
}
