"""An independent native flock holder, driven by explicit pipe barriers."""
import fcntl
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("held", flush=True)
    if sys.stdin.readline().strip() != "exit":
        raise RuntimeError("expected exit command")
    # os._exit bypasses finally, so the kernel must release this lock.
    os._exit(0)
finally:
    os.close(descriptor)
