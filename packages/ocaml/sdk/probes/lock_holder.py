"""An independent native flock holder, driven by explicit pipe barriers."""
import fcntl
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDWR)
fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
print("held", flush=True)
if sys.stdin.readline().strip() != "exit":
    raise RuntimeError("expected exit command")
# Deliberately die without unlocking or closing: the kernel releases the lock.
os._exit(0)
