"""An independent peer takes exactly the protocol's native store lock."""

import ctypes
import json
import os
from pathlib import Path
import re
import sys

lock_path, policy_path, contract_path = sys.argv[1:]
policy = json.loads(Path(policy_path).read_text())
fd = os.open(lock_path, os.O_RDONLY | os.O_CREAT, int(policy["fileMode"]["value"], 8))
try:
    if os.name == "nt":
        import msvcrt
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [
                ("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE),
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        lock = kernel.LockFileEx
        lock.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
            wintypes.DWORD, ctypes.POINTER(Overlapped),
        ]
        lock.restype = wintypes.BOOL
        where = Overlapped()
        contract = Path(contract_path).read_text()
        stated = re.search(r"OffsetHigh: (0x[0-9A-Fa-f]+)", contract)
        assert stated is not None and "on one byte of the lock file" in contract
        where.OffsetHigh = int(stated.group(1), 16)
        if not lock(msvcrt.get_osfhandle(fd), 2, 0, 1, 0, ctypes.byref(where)):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX)
    print("held", flush=True)
    sys.stdin.readline()
finally:
    os.close(fd)
