# make help: the Makefile's `##` lines, in order. It reads the Makefile twice: first for the
# widest name, then to print.
#
#   ##@ text            a line of its own, after a blank one: a section's heading
#   ## name: text       an entry, its text aligned with every other's and wrapped at 80 columns
#
# An entry whose text is <codegen groups> lists the groups in the file `-v groups=` names.

function fail(message) {
  print "make help: " message | "cat 1>&2"
  failed = 1
  exit 1
}

function codegen(   line, list) {
  while ((getline line < groups) > 0) list = list (list == "" ? "" : " ") line
  close(groups)
  if (list == "") fail("no codegen groups in " groups)
  return list
}

function entry(text,   at) {
  at = index(text, ": ")
  if (at == 0) fail("\"" text "\" has no \": \" between its name and its text")
  name = substr(text, 1, at - 1)
  description = substr(text, at + 2)
}

function wrap(name, description, column,   indent, words, n, i, line) {
  indent = sprintf("%" (column + 4) "s", "")
  n = split(description, words, " ")
  line = sprintf("  %-" column "s  %s", name, words[1])
  for (i = 2; i <= n; i++) {
    if (length(line) + 1 + length(words[i]) > 80) {
      print line
      line = indent words[i]
    } else {
      line = line " " words[i]
    }
  }
  print line
}

NR == FNR {
  if ($0 ~ /^## /) {
    entry(substr($0, 4))
    if (length(name) > width) width = length(name)
  }
  next
}

/^##@ / {
  if (printed) print ""
  print substr($0, 5)
  printed = 1
}

/^## / {
  entry(substr($0, 4))
  if (description == "<codegen groups>") description = codegen()
  wrap(name, description, width)
}

END { if (failed) exit 1 }
