// expect: SEM006
namespace Xunit
{
    public sealed class FactAttribute : System.Attribute
    {
        public string? Skip { get; set; }
    }
}
public sealed class Refusal
{
    [Xunit.Fact(Skip = "later")]
    public void Read() {}
}
