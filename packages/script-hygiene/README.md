# @bidspoke/script-hygiene

Trailing whitespace stripping for code node scripts (#1117), applied by the
canvas serialiser and by every worker route that writes a definition, so a
pasted script cannot carry column padding into storage. It leaves lines inside
template literals alone, because those spaces are part of the value.
