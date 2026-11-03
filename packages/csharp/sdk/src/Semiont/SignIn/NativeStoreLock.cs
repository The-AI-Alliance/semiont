using System.ComponentModel;
using System.Runtime.InteropServices;
using Semiont.Protocol;
using Microsoft.Win32.SafeHandles;

namespace Semiont.SignIn;

internal static partial class NativeStoreLock
{
    [LibraryImport("libc", EntryPoint = "open", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    private static partial int Open(string path, int flags, uint mode);

    [LibraryImport("libc", EntryPoint = "flock", SetLastError = true)]
    private static partial int Flock(int file, int operation);

    [LibraryImport("kernel32.dll", EntryPoint = "LockFileEx", SetLastError = true)]
    private static partial int LockFile(nint file, uint flags, uint reserved, uint low, uint high, ref NativeOverlapped overlapped);

    internal static async Task<FileStream> HoldAsync(string path, UnixFileMode mode, TimeProvider clock, Random random, CancellationToken cancellation)
    {
        var options = new FileStreamOptions { Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.ReadWrite | FileShare.Delete };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = mode;
        FileStream stream;
        if (OperatingSystem.IsWindows()) stream = new FileStream(path, options);
        else
        {
            // FileStream's Unix open takes its own shared flock, which conflicts with the native exclusive lock.
            var descriptor = Open(path, 2 | (OperatingSystem.IsMacOS() ? 0x200 | 0x1000000 : 0x40 | 0x80000), (uint)mode);
            if (descriptor < 0) throw new IOException("Could not open the sign-in lock", new Win32Exception(Marshal.GetLastPInvokeError()));
            var handle = new SafeFileHandle(descriptor, ownsHandle: true);
            try { stream = new FileStream(handle, FileAccess.ReadWrite); }
            catch { handle.Dispose(); throw; }
        }
        try
        {
            while (true)
            {
                cancellation.ThrowIfCancellationRequested();
                int error;
                if (OperatingSystem.IsWindows())
                {
                    var overlapped = new NativeOverlapped { OffsetHigh = checked((int)ProtocolTables.WindowsOffsetHigh) };
                    if (LockFile(stream.SafeFileHandle.DangerousGetHandle(), 3, 0, 1, 0, ref overlapped) != 0) return stream;
                    error = Marshal.GetLastPInvokeError();
                    if (error != 33) throw new IOException("Could not lock the sign-in store", new Win32Exception(error));
                }
                else
                {
                    if (Flock(stream.SafeFileHandle.DangerousGetHandle().ToInt32(), 6) == 0) return stream;
                    error = Marshal.GetLastPInvokeError();
                    if (error != 4 && error != (OperatingSystem.IsMacOS() ? 35 : 11)) throw new IOException("Could not lock the sign-in store", new Win32Exception(error));
                }
                // Nonblocking OS calls keep cancellation responsive while another process holds the lock.
                await Task.Delay(TimeSpan.FromMilliseconds(10 + random.NextDouble() * 10), clock, cancellation).ConfigureAwait(false);
            }
        }
        catch { stream.Dispose(); throw; }
    }
}
