# Programs that must not type-check

Each file here is a small program with one mistake per marked line: the kind of
mistake this SDK's types exist to refuse. Nothing runs them. `mypy` and
`pyright` check them with the rest of the package, and each marked line carries
the one error each checker must raise there:

```python
MarkDeleteCommand(annotation_id=resource)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
```

Both checkers are configured to treat a silencing comment that silences nothing
as an error. So a line here that starts to type-check, because a type went
loose, a generator flag changed or a checker's default moved, fails the checker
that stopped refusing it. That is the whole mechanism: these files are how a
loosened type is noticed.

A mistake that a checker reports under another code than the one written fails
too, with both the real error and the unused comment.
