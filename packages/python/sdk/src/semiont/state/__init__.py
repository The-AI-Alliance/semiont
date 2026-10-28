"""A client's state units: its long-running flows, held as state a consumer reads and watches.

None presumes a screen: a terminal, a daemon and an agent watching what a
person does read them alike.

Each is built over a client it is given and never closes. It listens to the
client's own bus from the moment it exists, so nothing said after it was built
is missed, and it hears what is said in the order it was said. A unit is built
inside a running event loop. What it does in answer to a signal it does a turn
of the loop later.

`dispose()` ends a unit: what it had running is cancelled, and nothing it is
told afterwards does anything. Held with `async with`, a unit is disposed on the
way out, and what it had running has ended by then.
"""

from semiont.state.beckon import BeckonStateUnit
from semiont.state.gather import GatherStateUnit
from semiont.state.hover import HoverDwell
from semiont.state.mark import MarkStateUnit, PendingAnnotation
from semiont.state.match import MatchStateUnit
from semiont.state.search import SearchPipeline, SearchState
from semiont.state.yield_ import YieldStateUnit

__all__ = [
    "BeckonStateUnit",
    "GatherStateUnit",
    "HoverDwell",
    "MarkStateUnit",
    "MatchStateUnit",
    "PendingAnnotation",
    "SearchPipeline",
    "SearchState",
    "YieldStateUnit",
]
