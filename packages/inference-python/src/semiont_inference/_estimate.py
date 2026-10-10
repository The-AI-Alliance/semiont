"""About how many tokens a prompt is, and whether it and its budget fit a model's window, before a provider has counted anything.

It is for a driver whose server does not refuse what does not fit: the
Ollama driver, which also sizes its request by the estimate, and the
llama.cpp driver. An estimate is never answered as what a call cost: that is
the provider's own count (`semiont_inference._tokens`).
"""

import math
from typing import Final

# The rule of `estimateTokens` in TypeScript's core (packages/core/src/chunking.ts),
# which cuts a text into pieces by it too: about four code points to a token,
# rounded up. Python has no chunking yet. When it has, the two must have one home.
_CODE_POINTS_PER_TOKEN: Final = 4


def estimate_that_fits(prompt: str, max_tokens: int, *, model: str, context_tokens: int) -> int:
    """About how many tokens `prompt` is, where it and a budget of `max_tokens` fit the window of `context_tokens` that `model` has.

    Raises `ValueError` where they do not. A server that is sent more than
    its window holds clips the prompt or cuts the answer short, and says
    neither: so what cannot fit is refused by the driver that would send it,
    before it sends anything.

    The estimate is not the provider's count. It leaves out what a model's
    chat template adds, and a prompt it lets through can still be over.
    """
    prompt_tokens = math.ceil(len(prompt) / _CODE_POINTS_PER_TOKEN)
    if prompt_tokens + max_tokens > context_tokens:
        raise ValueError(
            f"Prompt (~{prompt_tokens} tokens) + output budget ({max_tokens}) exceed the '{model}' context window ({context_tokens} tokens)"
        )
    return prompt_tokens
