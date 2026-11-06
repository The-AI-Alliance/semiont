namespace Semiont.Tests;

/// <summary>The lowest draw a source can give, every time: an equal jitter of it is half its cap.</summary>
internal sealed class ZeroRandom : Random
{
    public override double NextDouble() => 0;
}
