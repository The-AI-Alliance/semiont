"""What a model is told a language is called, held to the registry of the languages Semiont supports (`specs/src/locales/registry.json`)."""

from typing import Annotated, Final

from pydantic import BaseModel, Field
from spec import SPEC

from semiont_worker.locales import ENGLISH_NAMES, language_name


class Language(BaseModel, frozen=True, extra="forbid", strict=True):
    code: str
    native_name: Annotated[str, Field(alias="nativeName")]
    english_name: Annotated[str, Field(alias="englishName")]


class Registry(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    locales: list[Language]


REGISTRY: Final = Registry.model_validate_json((SPEC / "locales/registry.json").read_bytes())


def test_the_names_are_the_registrys_each_language_once_and_in_its_order() -> None:
    # The table is written out by hand here, and nothing generates it: a language the registry gains, loses or renames fails here.
    assert len(REGISTRY.locales) >= 29
    assert list(ENGLISH_NAMES.items()) == [(language.code, language.english_name) for language in REGISTRY.locales]


def test_a_language_is_found_by_its_code_in_whatever_case_it_is_written() -> None:
    for language in REGISTRY.locales:
        assert language_name(language.code) == language.english_name
        assert language_name(language.code.upper()) == language.english_name


def test_a_tag_the_registry_lacks_is_said_as_it_is() -> None:
    for tag in ("tlh", "de-CH", "EN-us", ""):
        assert tag.lower() not in {language.code for language in REGISTRY.locales}
        assert language_name(tag) == tag
