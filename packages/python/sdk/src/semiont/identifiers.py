# Generated from specs/src/identifiers/kinds.json and each kind's schema; do not edit.
# Regenerate: node scripts/spec/generate-identifiers-python.mjs

"""The kinds of id.

A value of one of these types is text that passed its kind's rule, which is the
schema's pattern. It is made here and nowhere else: by the kind's constructor,
which raises `InvalidIdentifier` for text the rule refuses, by `parse`, which
answers `None` instead, and by decoding, which goes through the same rule. It
is a `str`, so it reads as the text it is. One kind is not another: a type
checker refuses a `ResourceId` where an `AnnotationId` is wanted.
"""

import re
from typing import ClassVar, Final, Self, final

from pydantic import GetCoreSchemaHandler
from pydantic_core import CoreSchema, core_schema

__all__ = ["AnnotationId", "InvalidIdentifier", "JobId", "ResourceId", "UserId"]


@final
class InvalidIdentifier(ValueError):
    """Text that is not an id of the kind it was to be."""

    def __init__(self, kind: str, pattern: str, value: str) -> None:
        super().__init__(f"{value!r} is not a {kind}: it does not match {pattern}")
        self.kind: Final = kind
        self.pattern: Final = pattern
        self.value: Final = value


class _Identifier(str):
    """What the kinds share: text held to a rule, wherever it is made."""

    __slots__ = ()
    PATTERN: ClassVar[str]
    """The kind's rule, as its schema states it."""
    _RULE: ClassVar[re.Pattern[str]]

    def __new__(cls, text: str) -> Self:
        if cls._RULE.fullmatch(text) is None:
            raise InvalidIdentifier(cls.__name__, cls.PATTERN, text)
        return super().__new__(cls, text)

    @classmethod
    def parse(cls, text: str) -> Self | None:
        """`text` as this kind of id, or `None` when the kind's rule refuses it.

        For where text that is not an id is an ordinary answer and not a fault:
        an address someone typed, a key read from storage.
        """
        return super().__new__(cls, text) if cls._RULE.fullmatch(text) is not None else None

    @classmethod
    def __get_pydantic_core_schema__(cls, source: object, handler: GetCoreSchemaHandler) -> CoreSchema:
        # Decoding goes through the constructor: an id in an answer passed the
        # same rule as one a caller made.
        return core_schema.no_info_after_validator_function(cls, core_schema.str_schema())


@final
class ResourceId(_Identifier):
    """A resource's id: a name, never the resource's URI or a path. 1 to 128 of the letters `A`–`Z`
    and `a`–`z`, the digits, `_` and `-`. It is one segment of a URL and one name in a file
    system, and it is held to that wherever it enters: a gateway refuses a payload that carries
    anything else. How one is made is no part of the rule. `__system__` is the one that names no
    resource: the scope events about the knowledge base itself are logged under.
    """

    __slots__ = ()
    PATTERN: ClassVar[str] = "^[A-Za-z0-9_-]{1,128}$"
    _RULE: ClassVar[re.Pattern[str]] = re.compile("[A-Za-z0-9_-]{1,128}")


@final
class AnnotationId(_Identifier):
    """An annotation's id: a name, never the annotation's URI. 1 to 128 of the letters `A`–`Z` and
    `a`–`z`, the digits, `_` and `-`. It is one segment of a URL and one name in a file system,
    and it is held to that wherever it enters: a gateway refuses a payload that carries anything
    else. How one is made is no part of the rule.
    """

    __slots__ = ()
    PATTERN: ClassVar[str] = "^[A-Za-z0-9_-]{1,128}$"
    _RULE: ClassVar[re.Pattern[str]] = re.compile("[A-Za-z0-9_-]{1,128}")


@final
class JobId(_Identifier):
    """A job's id. 1 to 128 of the letters `A`–`Z` and `a`–`z`, the digits, `_` and `-`. It is one
    segment of a URL and one name in a file system, and it is held to that wherever it enters: a
    gateway refuses a payload that carries anything else. How one is made is no part of the
    rule.
    """

    __slots__ = ()
    PATTERN: ClassVar[str] = "^[A-Za-z0-9_-]{1,128}$"
    _RULE: ClassVar[re.Pattern[str]] = re.compile("[A-Za-z0-9_-]{1,128}")


@final
class UserId(_Identifier):
    """The identity of whoever did something, a person or a software agent alike: a DID
    (`did:web:<domain>:users:<subject>`, `did:web:<domain>:agents:<provider>:<model>`), with no
    whitespace in it. Never a name, an address, or a row in a table. What follows `did:` is not
    constrained further: a subject is the issuer's, percent-encoded, and that encoding leaves
    some punctuation as it is.
    """

    __slots__ = ()
    PATTERN: ClassVar[str] = "^did:\\S+$"
    _RULE: ClassVar[re.Pattern[str]] = re.compile("did:\\S+")
