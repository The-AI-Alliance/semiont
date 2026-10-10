"""The model providers Semiont's Python services call, behind one interface.

Every name is imported from the module that has it, and from nowhere else:
what a client is, what it answers and how it fails
(`semiont_inference.interface`); making a client from what a knowledge base's
config names (`semiont_inference.factory`); what a service that holds clients
reports of its models' limits (`semiont_inference.limits_report`); and what a
model catalogue file says of a model whose provider does not say it itself,
read from the path it is given (`semiont_inference.catalogue`).

A driver is a module too: `semiont_inference.anthropic`,
`semiont_inference.ollama`, `semiont_inference.openai`, and
`semiont_inference.mock`, which answers from a list, for tests. Importing this package imports none of them, so it imports
no provider's library: a driver whose provider has a library of its own comes
with an extra of this package, and only whoever asks for that driver needs it.
"""
