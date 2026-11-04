namespace Semiont.State;

public sealed record KbIdentityConflict(string ExpectedDid, string ObservedDid);
public sealed record PermissionDenied(string? Detail);
public sealed record SessionEnded(string Reason);

/// <summary>Notices for the host. Raising the same notice twice is observable twice.</summary>
public sealed class SessionSignals : IStateUnit
{
    public StateValue<SessionEnded?> SessionEnded { get; } = new(null);
    public StateValue<PermissionDenied?> PermissionDenied { get; } = new(null);
    public StateValue<KbIdentityConflict?> KbIdentityConflict { get; } = new(null);

    public void NotifySessionEnded(string reason) => SessionEnded.Set(new SessionEnded(reason), repeat: true);
    public void NotifyPermissionDenied(string? detail) => PermissionDenied.Set(new PermissionDenied(detail), repeat: true);
    public void NotifyKbIdentityConflict(KbIdentityConflict conflict) => KbIdentityConflict.Set(conflict, repeat: true);
    public void AcknowledgeSessionEnded() => SessionEnded.Set(null, repeat: true);
    public void AcknowledgePermissionDenied() => PermissionDenied.Set(null, repeat: true);
    public void AcknowledgeKbIdentityConflict() => KbIdentityConflict.Set(null, repeat: true);

    public void Dispose()
    {
        SessionEnded.Close();
        PermissionDenied.Close();
        KbIdentityConflict.Close();
    }
}
