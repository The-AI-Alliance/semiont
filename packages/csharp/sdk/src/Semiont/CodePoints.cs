using System.Text;

namespace Semiont;

internal static class CodePoints
{
    /// <summary>Texts in the order of their code points, the order the protocol gives names in. UTF-8's bytes are in
    /// that order, where UTF-16's units are not.</summary>
    internal static readonly Comparer<string> Order = Comparer<string>.Create((left, right) =>
        Encoding.UTF8.GetBytes(left).AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(right)));
}
