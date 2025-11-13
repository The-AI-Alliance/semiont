#!/usr/bin/env python3
"""
Legal Citation Detector

Reads text from STDIN and outputs detected legal citations as JSON.
Uses eyecite library to extract citations with their positions.

Output format:
{
  "citations": [
    {
      "text": "Bush v. Gore, 531 U.S. 98 (2000)",
      "start": 100,
      "end": 133,
      "type": "FullCaseCitation"
    },
    ...
  ]
}
"""

import sys
import json
from eyecite import get_citations


def main():
    # Read all text from stdin
    text = sys.stdin.read()

    if not text:
        json.dump({"citations": []}, sys.stdout, indent=2)
        return

    # Extract citations using eyecite
    citations = get_citations(text)

    # Convert citations to JSON-serializable format
    result = []
    for citation in citations:
        # Get citation type name
        citation_type = type(citation).__name__

        # Get the matched text - extract just the text from the span
        span = citation.span()
        if not span:
            continue

        start, end = span
        matched_text = text[start:end]

        result.append({
            "text": matched_text,
            "start": start,
            "end": end,
            "type": citation_type
        })

    # Output JSON to stdout
    json.dump({"citations": result}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
