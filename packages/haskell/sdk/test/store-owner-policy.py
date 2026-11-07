"""Check actual native permissions against the shared writer policy."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys

policy_path, directory, filename = sys.argv[1:]
policy = json.loads(Path(policy_path).read_text())
if os.name == "nt":
    subprocess.run(
        [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(Path(__file__).with_suffix(".ps1")), policy_path, directory, filename,
        ],
        check=True,
    )
else:
    assert stat.S_IMODE(os.stat(directory).st_mode) == int(policy["directoryMode"]["value"], 8)
    assert stat.S_IMODE(os.stat(filename).st_mode) == int(policy["fileMode"]["value"], 8)
