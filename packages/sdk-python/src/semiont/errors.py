"""A failure, as this SDK reports one: under a code of `specs/src/errors/codes.json`.

Every failure is a `SemiontError`, and each vocabulary of codes has a class of
its own, so `except BusRequestError` reads as what it catches and a `match`
over `error.code` is checked to name every code.
"""

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Final, final, override

from pydantic import JsonValue

from semiont.error_codes import (
    BUS_REQUEST_CODE_BY_WIRE_CODE,
    UNRECOGNIZED_FAILURE_CODE,
    BusRequestErrorCode,
    JobErrorCode,
    SemiontSessionErrorCode,
    SignInErrorCode,
    SpanRefusal,
    TransportErrorCode,
    transport_error_code_for_status,
)
from semiont.identifiers import JobId

__all__ = ["BusRequestError", "JobError", "SemiontError", "SessionError", "SignInError", "SpanRefusedError", "TransportError"]


class SemiontError(Exception, ABC):
    """One failure. Its text is for a person; a program reads its `code`."""

    def __init__(self, message: str, *, status: int | None = None, retry_after_ms: int | None = None) -> None:
        super().__init__(message)
        self.message: Final = message
        self.status: Final = status
        """The HTTP status, when a server stated one."""
        self.retry_after_ms: Final = retry_after_ms
        """The wait a refusal's `Retry-After` stated, in milliseconds, when it stated one."""

    @property
    @abstractmethod
    def code(self) -> str:
        """Which failure this is, in its vocabulary."""


@final
class TransportError(SemiontError):
    """A request a server refused, or one that got no answer."""

    def __init__(self, code: TransportErrorCode, message: str, *, status: int | None = None, retry_after_ms: int | None = None) -> None:
        super().__init__(message, status=status, retry_after_ms=retry_after_ms)
        self._code: Final = code

    @property
    @override
    def code(self) -> TransportErrorCode:
        return self._code

    @classmethod
    def of_status(cls, message: str, status: int, retry_after_ms: int | None) -> "TransportError":
        """A server answered, and its status decides the code."""
        return cls(transport_error_code_for_status(status), message, status=status, retry_after_ms=retry_after_ms)

    @classmethod
    def without_response(cls, message: str) -> "TransportError":
        """Nothing answered: the connection failed, or the request's deadline passed."""
        return cls("unavailable", message)


@final
class BusRequestError(SemiontError):
    """A request over the bus that did not resolve with its response."""

    def __init__(self, code: BusRequestErrorCode, message: str, *, failure: Mapping[str, JsonValue] | None = None) -> None:
        super().__init__(message)
        self._code: Final = code
        self.failure: Final = failure
        """What the peer answered on the operation's failure channel, when the peer answered."""

    @property
    @override
    def code(self) -> BusRequestErrorCode:
        return self._code

    @classmethod
    def answered(cls, failure: Mapping[str, JsonValue]) -> "BusRequestError":
        """The failure a peer answered with, under the code its own code becomes.

        A failure that states no code, or one this vocabulary does not name,
        is `UNRECOGNIZED_FAILURE_CODE`: the peer may be newer than this build.
        """
        stated = failure.get("code")
        said = failure.get("message")
        code = (
            BUS_REQUEST_CODE_BY_WIRE_CODE.get(stated, UNRECOGNIZED_FAILURE_CODE) if isinstance(stated, str) else UNRECOGNIZED_FAILURE_CODE
        )
        return cls(code, said if isinstance(said, str) else "Bus request rejected", failure=failure)


@final
class JobError(SemiontError):
    """A job its follower saw end without completing: it failed for good, was cancelled, or said nothing for too long."""

    def __init__(self, code: JobErrorCode, message: str, *, job_id: JobId | None) -> None:
        super().__init__(message)
        self._code: Final = code
        self.job_id: Final = job_id
        """The job, when its creation was answered: one that stalled before that has no id."""

    @property
    @override
    def code(self) -> JobErrorCode:
        return self._code


@final
class SignInError(SemiontError):
    """A sign-in at the issuer a knowledge base trusts, or a renewal there, that did not succeed.

    One that carries a status is the issuer's answer. One that carries none
    got no answer: a refusal and an outage are different events.
    """

    def __init__(self, code: SignInErrorCode, message: str, *, status: int | None = None) -> None:
        super().__init__(message, status=status)
        self._code: Final = code

    @property
    @override
    def code(self) -> SignInErrorCode:
        return self._code


@final
class SessionError(SemiontError):
    """A failure that makes a session itself unusable. A request's own failure stays with its caller."""

    def __init__(self, code: SemiontSessionErrorCode, message: str, *, kb_id: str) -> None:
        super().__init__(message)
        self._code: Final = code
        self.kb_id: Final = kb_id
        """The knowledge base the session was with."""

    @property
    @override
    def code(self) -> SemiontSessionErrorCode:
        return self._code


@final
class SpanRefusedError(SemiontError):
    """A span no annotation was built of: it is not the text's, or, for a PDF, is nowhere on its pages."""

    def __init__(self, code: SpanRefusal, message: str) -> None:
        super().__init__(message)
        self._code: Final = code

    @property
    @override
    def code(self) -> SpanRefusal:
        return self._code
