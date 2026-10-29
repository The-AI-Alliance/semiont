"""What more than one module of the tests asks pytest for."""

import logging
from collections.abc import Generator

import pytest

from semiont_weaver.log import LOG


@pytest.fixture
def the_log_as_it_was() -> Generator[None]:
    """A process's logging is configured once, by the service as it boots. A test that configures it puts it back."""
    everything = logging.getLogger()
    handlers, level, own = list(everything.handlers), everything.level, LOG.level
    yield
    everything.handlers[:] = handlers
    everything.setLevel(level)
    LOG.setLevel(own)
    logging.captureWarnings(False)
