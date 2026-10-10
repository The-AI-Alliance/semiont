"""Programs that must not type-check.

Each file here is a small program with one mistake on each marked line: the
kind of mistake this package's types exist to refuse. `mypy` and `pyright`
check them with the rest of the package, and each marked line carries the one
error each checker must raise there. Both checkers treat a silencing comment
that silences nothing as an error, so a line here that starts to type-check
fails the checker that stopped refusing it.

A test may also run one, to see that what a checker refuses is refused when
the program is run all the same.
"""
