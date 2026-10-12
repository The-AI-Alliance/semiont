"""Semiont's Librarian: the service that answers what a knowledge base holds, from its graph, its vector index and a model.

What it does is written rule by rule in `docs/protocol/LIBRARIAN.md`. It
records nothing and owns no store. Everything it reads is handed to it
(`reads`). Every name is imported from the module that has it, and from
nowhere else.
"""
