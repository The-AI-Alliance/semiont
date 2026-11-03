namespace Semiont.Errors;

public abstract class SemiontError : Exception
{
    private protected SemiontError(string code, string message, int? status = null, Exception? inner = null) : base(message, inner)
    {
        Code = code;
        Status = status;
    }

    public string Code { get; }
    public int? Status { get; }
}

public sealed class BusRequestError(string code, string message) : SemiontError(code, message);

public sealed class TransportError(string code, string message, int? status = null, Exception? inner = null) : SemiontError(code, message, status, inner);

public sealed class SignInError(string code, string message, int? status = null, Exception? inner = null) : SemiontError(code, message, status, inner);
