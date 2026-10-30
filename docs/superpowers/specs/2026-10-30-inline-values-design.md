# Inline values — design

**Goal.** While writing Terraform, see what expressions evaluate to for the selected environment — locals, variables,
`for_each` / `count`, outputs, any selection — the way a debugger shows inline values. Today people paste expressions
into `terraform console` by hand.

## How values are computed

Terraform's own evaluator, never a reimplementation, and never on the real state:

- **Mirror.** The env's root and every local module it calls (recursively, `source = "./…"`/`"../…"`) are copied, with
  their relative layout, into `<globalStorage>/eval/<hash>/` (no `.terraform`, `.git`, `node_modules`, files > 1 MB).
  Unsaved editor text of `.tf` files is written over the saved one, so values follow typing (on a short debounce).
- **Isolation.** `zz_planlens_override.tf` sets `backend "local"` to a state in the mirror: `terraform console` locks
  the state it reads, so it must never touch the team's remote state. Resources are therefore not in state: their
  attributes show `(known after apply)`.
- **Init** once per mirror (and again when Terraform says so), with a shared `TF_PLUGIN_CACHE_DIR` so providers are
  downloaded once. A workspace env gets its workspace created in the local state, then `TF_WORKSPACE`.
- **Batch.** `zz_planlens_eval.tf` holds one local per expression, verbatim (multi-line HCL works):
  `__pl_3 = try(jsonencode(<expr>), "!err")`. The console is asked one line, `{ e0 = local.__pl_0, … }`, and prints one
  `"eN" = "<json>"` per expression, `(known after apply)` or `(sensitive value)` per key. A static error names
  `zz_planlens_eval.tf line N`: that expression gets the error message and the batch runs again without it.
- `-var-file` is the env's tfvars (absolute path); root `terraform.tfvars` / `*.auto.tfvars` are in the mirror.
- Runs only in trusted workspaces, like plans.

## What is evaluated (root module files of the env's root)

- `locals` attributes → `local.<name>`, on the attribute's line.
- `variable "x"` → `var.x`, on the header line.
- `for_each` / `count` of resource, data and module blocks → the expression text, shown as `3 instances: "app", "db", "pe"`.
- `output` `value` → the expression text.
- Expressions using `each.`, `count.`, `self.` are skipped (no value outside an instance).
- **Evaluate selection** (editor context menu): any selected expression of a root file, result in a hover.

## Display

- End-of-line hint in the editor's code-lens colour: `= "rg-qual-data"`, `= { app = "10.0.0.0/24", … }` (HCL style,
  cut at ~60 chars); `(known after apply)`, `(sensitive)`; errors as `⚠ Reference to undeclared local value`.
- Hover on that line: the full value, pretty HCL, with the env name.
- `planLens.inlineValues` (default on) turns it off.

## Testing

Pure units: the target scanner (locals, multi-line for expressions, heredocs, comments, skipped `each`), the batch file
and console output parser (strings with escapes, unknown, sensitive, errors by line), the HCL formatter. End to end in
VS Code: hover shows a local's value for the env, a for_each instance count, an error inline.
