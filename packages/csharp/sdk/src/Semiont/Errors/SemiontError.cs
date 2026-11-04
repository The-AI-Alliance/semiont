using Semiont.Identifiers;
using Semiont.Types;

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

public sealed class SessionError(string code, string message, Exception? inner = null) : SemiontError(code, message, inner: inner);

public sealed class JobError : SemiontError
{
    internal JobError(string code, string message, JobId? jobId, FailureClass? failureClass = null) : base(code, message)
    {
        JobId = jobId;
        FailureClass = failureClass;
    }

    public JobId? JobId { get; }
    public FailureClass? FailureClass { get; }
}
