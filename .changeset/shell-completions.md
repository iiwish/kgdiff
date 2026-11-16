---
'@kgdiff/cli': patch
---

Shell completions: `kgdiff completion <bash|zsh|fish>` prints a completion script for the shell. It completes the options (long and short), the values of the options that take one of a fixed set (`--format`, `--match`, `--edge-identity`, `--theme`, `--mode`, `--scope`, `--color`, `--locale` and the two per-side formats), file names where a file is expected, and the `apply`, `help` and `completion` commands with their own options. Install it once (`kgdiff completion zsh > "${fpath[1]}/_kgdiff"`, `kgdiff completion bash > ~/.local/share/bash-completion/completions/kgdiff`, `kgdiff completion fish > ~/.config/fish/completions/kgdiff.fish`) or load it when the shell starts (`source <(kgdiff completion bash)`). The scripts are generated from the tables the command line is parsed with, so they list exactly the options of the version that printed them; `kgdiff help completion` has the details.

`completion` is a command as the first argument, like `apply` and `help`: to compare a file of that name, write it as a path (`./completion`).
