"""A provider's own library is an extra: the package is whole without it, and says what to install when a driver needs it.

Each program here is run by an interpreter of its own, so that what it
imports is what the program itself asked for, and not what another test had
already imported.
"""

import subprocess
import sys

LIMITS = "InferenceLimits(context_tokens=1, max_output_tokens=1, output_tokens_per_hour=None, accepts_temperature=None)"

# The modules of Anthropic's library, and of the HTTP library it brings, that a program has imported.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] in ("anthropic", "httpx2"))'

WITHOUT_ASKING_FOR_ANTHROPIC = f"""
import sys
import semiont_inference
from semiont_inference.factory import create_inference_client
from semiont_inference.interface import InferenceLimits
from semiont_inference.mock import MockInferenceClient

ollama = create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None)
mock = MockInferenceClient(["[]"], stop_reasons=["end_turn"], limits={LIMITS})
print(ollama.provider, mock.provider, {LOADED}, "semiont_inference.anthropic" in sys.modules)
"""

ASKING_FOR_ANTHROPIC = """
import sys
from semiont_inference.factory import create_inference_client

client = create_inference_client(provider="anthropic", model="claude-x", base_url="http://127.0.0.1:1", api_key="k")
print(client.provider, "anthropic" in sys.modules, "semiont_inference.anthropic" in sys.modules)
"""

WITHOUT_THE_LIBRARY = """
import sys

sys.modules["anthropic"] = None  # as an interpreter has it where the library is not installed
from semiont_inference.factory import create_inference_client

for ask in ("the factory", "the module"):
    try:
        if ask == "the factory":
            create_inference_client(provider="anthropic", model="claude-x", base_url="http://127.0.0.1:1", api_key="k")
        else:
            import semiont_inference.anthropic
    except ModuleNotFoundError as missing:
        print(ask, "|", type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None).provider)
"""


def alone(program: str) -> str:
    """What `program` printed, run by an interpreter of its own."""
    ran = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, check=False)
    assert ran.returncode == 0, ran.stderr
    return ran.stdout


def test_the_package_an_ollama_client_and_a_mock_import_no_part_of_anthropics_library() -> None:
    assert alone(WITHOUT_ASKING_FOR_ANTHROPIC) == "ollama mock [] False\n"


def test_asking_for_an_anthropic_client_is_what_imports_the_library() -> None:
    # The other half: the program above would print the same of a package that never imported the library at all.
    assert alone(ASKING_FOR_ANTHROPIC) == "anthropic True True\n"


def test_without_the_library_an_anthropic_client_fails_naming_the_extra_and_an_ollama_client_is_made() -> None:
    said = (
        "The Anthropic driver needs Anthropic's `anthropic` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[anthropic]`."
    )
    assert alone(WITHOUT_THE_LIBRARY).splitlines() == [
        f"the factory | ModuleNotFoundError | anthropic | ModuleNotFoundError | {said}",
        f"the module | ModuleNotFoundError | anthropic | ModuleNotFoundError | {said}",
        "ollama",
    ]
