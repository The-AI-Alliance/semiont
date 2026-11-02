using System.Diagnostics;
using System.Text.RegularExpressions;

if (args.Length != 5)
{
    throw new ArgumentException("Expected compiler, references, analyzer, refusal directory, and output directory.");
}
var files = Directory.GetFiles(args[3], "*.cs").Order().ToArray();
if (files.Length == 0)
{
    throw new InvalidOperationException("No refusal files were found.");
}
Directory.CreateDirectory(args[4]);
foreach (var file in files)
{
    var expected = Regex.Match(File.ReadAllText(file), @"^// expect: ([A-Z]+[0-9]+)$", RegexOptions.Multiline);
    if (!expected.Success)
    {
        throw new InvalidOperationException($"{file} states no expected diagnostic.");
    }
    var start = new ProcessStartInfo("dotnet")
    {
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
    };
    foreach (var argument in new[] { args[0], "-nologo", "-target:library", "-nullable:enable", "-warnaserror+",
        "@" + args[1], "-analyzer:" + args[2], "-out:" + Path.Combine(args[4], Path.GetFileNameWithoutExtension(file) + ".dll"), file })
    {
        start.ArgumentList.Add(argument);
    }
    using var process = Process.Start(start) ?? throw new InvalidOperationException("The compiler could not start.");
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    await process.WaitForExitAsync();
    var output = await stdout + await stderr;
    if (process.ExitCode == 0 || !Regex.IsMatch(output, @"\berror " + expected.Groups[1].Value + @"\b"))
    {
        throw new InvalidOperationException($"{file}: expected {expected.Groups[1].Value}; exit {process.ExitCode}\n{output}");
    }
    Console.WriteLine($"Refused {Path.GetFileName(file)}: {expected.Groups[1].Value}");
}
Console.WriteLine($"Verified {files.Length} compiler refusals.");
