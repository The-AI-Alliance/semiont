"""How each span was anchored: counted, and warned of where the place may be the wrong one.

That a span is the text's own words is checked where its annotation is
built, and cannot fail here. What can be wrong is which place was meant, and
two ways of finding a span choose a likely place and not a sure one:
`first-of-many`, where the text has the words in several places and nothing
the model said chose among them, and `fuzzy-match`, where the text does not
have them as quoted and a looser search found them. Neither is a failure.
Both are where a span may be the wrong one.

Every kind of detection notes its anchors here, so that one rule says which
are doubtful.
"""

from typing import Final

from semiont.annotations import AnchorMethod

from semiont_worker.log import LOG
from semiont_worker.telemetry import DetectionLabel, record_anchor

_DOUBTFUL: Final[frozenset[AnchorMethod]] = frozenset({"first-of-many", "fuzzy-match"})


def note_anchor(label: DetectionLabel, exact: str, method: AnchorMethod) -> None:
    """Count one anchor by what was anchored and how, and warn of one that may be the wrong place.

    Every anchor is counted, the sure ones too: a warning says one anchor
    was doubtful, and only the share of all of them says how far a job's
    spans are to be trusted. `exact` is the words as the model quoted them.
    """
    record_anchor(label, method)
    if method in _DOUBTFUL:
        LOG.warning("Annotation anchored via degraded method", extra={"label": label, "text": exact, "anchorMethod": method})
