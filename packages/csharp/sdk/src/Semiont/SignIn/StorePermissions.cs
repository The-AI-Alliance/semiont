using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Semiont.Protocol;

namespace Semiont.SignIn;

internal static class StorePermissions
{
    private static readonly JsonDocument Policy = JsonDocument.Parse(ProtocolTables.OwnerOnly);
    internal static UnixFileMode DirectoryMode => (UnixFileMode)Convert.ToInt32(Policy.RootElement.GetProperty("directoryMode").GetProperty("value").GetString(), 8);
    internal static UnixFileMode FileMode => (UnixFileMode)Convert.ToInt32(Policy.RootElement.GetProperty("fileMode").GetProperty("value").GetString(), 8);

    internal static void CreateDirectory(string path)
    {
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
        else Directory.CreateDirectory(path, DirectoryMode);
    }

    internal static void Keep(string path)
    {
        if (OperatingSystem.IsWindows()) KeepWindows(path);
        else File.SetUnixFileMode(path, DirectoryMode);
    }

    [SupportedOSPlatform("windows")]
    private static void KeepWindows(string path)
    {
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User?.Value ?? throw new IOException("The writer has no Windows identity");
        var stated = Policy.RootElement.GetProperty("accessList").GetProperty("value").GetString() ?? throw new InvalidOperationException("No owner-only access list");
        var target = new DirectorySecurity();
        target.SetSecurityDescriptorSddlForm(stated.Replace("{owner}", sid, StringComparison.Ordinal));
        var directory = new DirectoryInfo(path);
        var current = directory.GetAccessControl(AccessControlSections.Access);
        static HashSet<string> Rules(DirectorySecurity security) => security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(rule => $"{rule.IdentityReference.Value}:{rule.AccessControlType}:{(uint)rule.FileSystemRights}:{rule.InheritanceFlags}:{rule.PropagationFlags}:{rule.IsInherited}").ToHashSet(StringComparer.Ordinal);
        if (!current.AreAccessRulesProtected || !Rules(current).SetEquals(Rules(target))) directory.SetAccessControl(target);
    }
}
