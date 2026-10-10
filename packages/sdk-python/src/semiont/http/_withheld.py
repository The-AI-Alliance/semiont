"""What a failure says of an exchange, and what it withholds.

An exchange carries credentials: the token a request is made with, and the
token an answer grants. A failure is printed and logged, and what it is raised
from is printed with it. So no failure says a request or an answer in the
words of whatever read it, and none is raised from that reader's own failure.

The HTTP library's account of an error is told when the error is the
connection's: the far end was not reached, the socket or TLS beneath the
exchange broke, or time ran out. Its words are then the operating system's and
the TLS library's, and whoever runs the process needs them.

It is withheld for every other kind. A request or an answer that is not HTTP
is quoted by the parser that refused it, a header of the request and a line of
the answer alike; and a kind not named here is one nobody has vouched for.

An answer that is not the body its operation declares is said by what it
lacks: the decoder's account of it shows what it was given.
"""

from typing import Final

import httpx
from pydantic import ValidationError

from semiont.model import WireModel

# The kinds of error that are the connection's. Nothing that raises one has read a request or an answer as HTTP.
_OF_THE_CONNECTION: Final = (TimeoutError, httpx.NetworkError, httpx.TimeoutException)


def why_unanswered(error: TimeoutError | httpx.HTTPError) -> str:
    """Why a request got no answer, as its failure says it: the error's kind, and its words when it is the connection's.

    The failure that says it is raised `from None`: `error` is printed with
    whatever is raised from it, in words that are not this function's to
    choose.
    """
    if isinstance(error, _OF_THE_CONNECTION):
        return repr(error)
    return f"{type(error).__name__}, its own words withheld"


def lacks(declared: type[WireModel], error: ValidationError, what: str) -> str:
    """What an answer lacks to be `declared`, which a reader knows as `what`.

    It is said of the members `declared` has, by the names the wire gives
    them. None of it is the answer's own text, a member's name included, and
    none is the decoder's account of the failure.
    """
    found = error.errors(include_url=False, include_context=False, include_input=False)
    refused = {detail["loc"][0] for detail in found if detail["loc"]}
    absent = {detail["loc"][0] for detail in found if len(detail["loc"]) == 1 and detail["type"] == "missing"}
    members = (field.alias or name for name, field in declared.model_fields.items())
    lacking = [f"it has no `{member}`" if member in absent else f"its `{member}` is malformed" for member in members if member in refused]
    return "; ".join(lacking) if lacking else f"it is not the JSON object {what} is"
