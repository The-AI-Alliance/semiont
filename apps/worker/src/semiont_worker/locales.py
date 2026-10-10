"""What a model is told a language is called.

A job names a language by its tag, and a prompt says it by its English name.
The names are those of `specs/src/locales/registry.json`, the languages
Semiont supports. They are written out here by hand, and a test holds them
to the registry, each language and its order.
"""

from collections.abc import Mapping
from typing import Final

ENGLISH_NAMES: Final[Mapping[str, str]] = {
    "ar": "Arabic",
    "bn": "Bengali",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fa": "Persian",
    "fi": "Finnish",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "ms": "Malay",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "vi": "Vietnamese",
    "zh": "Chinese",
}
"""The English name of each language of the registry, by its code."""


def language_name(tag: str) -> str:
    """What a prompt calls the language `tag` names: its English name, or the tag itself where the registry has no such language.

    A code is found in whatever case it is written. Only a code is looked
    for: a tag that says more (`de-CH`) is no code of the registry, and is
    said as it is.
    """
    return ENGLISH_NAMES.get(tag.lower(), tag)
