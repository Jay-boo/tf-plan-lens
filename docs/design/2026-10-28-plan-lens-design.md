# Terraform Plan Lens — design

Date: 2026-10-28
Status: design and look approved in chat; spec awaiting review
Mockup: `2026-10-28-plan-lens-mockup.html` / `.png` (approved: "ok looks good")
Style reference: joblauncher_databricks `media/webview/base.css` (Sixth v2). Build setup copied from gitland.

## Why

Reading `terraform plan` output to spot the one dangerous change (a replace forced by an attribute, a destroy) is
slow and easy to get wrong. Plan Lens puts the plan on the code: every resource block shows what will happen to it,
and a Sixth-styled sidebar lists the changes with the risky ones first.

First user: the author, on `Infra - Terraform - DataPlatformRessources` (one root module, `environments/<ENV>/`
with `backend.conf` + `terraform.tfvars`, azurerm remote state, local modules under `./modules`, `lakebase` called
twice). Must work on any Terraform repo.

## Scope (v1)

In: run a plan for an environment, load an existing plan, editor decorations + hover, sidebar webview, status bar.
Out: apply (never), Terraform Cloud/remote runs, remote (registry/git) module source mapping in the editor (their
changes still appear in the sidebar), plan diffing between runs, Marketplace publishing.

## Getting a plan

**Run plan…** (`planLens.runPlan`, also the sidebar's Run mode and Re-plan button)
1. Environments are discovered by the glob `planLens.environmentGlob` (default `environments/**/terraform.tfvars`).
   Each match is an environment named by its folder path below `environments/` (`QUAL`, `PROD/dev`); a
   `backend.conf` in the same folder is used when present. The pick is remembered per workspace.
2. The Terraform root is the workspace folder containing the `environments` folder (setting `planLens.root`
   overrides it).
3. Commands, run with `cwd` = root and `TF_DATA_DIR` = `<extension globalStorage>/<root hash>/<env>` so the user's
   own `.terraform` is never touched:
   `terraform init -input=false -reconfigure [-backend-config=<backend.conf>]`
   `terraform plan -input=false -var-file=<tfvars> -out=<tmp>/plan.bin`
   `terraform show -json <tmp>/plan.bin`
   The binary path is `planLens.terraformPath` (default `terraform`). Output streams to the "Plan Lens" output
   channel (the Log button). A progress notification can cancel (kills the process).
4. The plan file is in a fresh `os.tmpdir()` folder and is deleted right after `show -json`, success or failure.
   The JSON lives in memory only; nothing is written to the repo.
5. Never `apply`, `destroy`, `import`, `state` or any write command. `plan` takes the state lock as usual.

**Load plan file…** (`planLens.loadPlan`, the sidebar's Load mode): pick a file. `.json` is parsed directly; any
other file is treated as a binary plan and converted with `terraform show -json` (needs the root's providers: if
that fails, the error says to run Plan or load the JSON instead).

**Errors**: non-zero exit shows an error notification with the last meaningful stderr line and **Open log**. If the
output mentions Azure auth (`az login`, `AADSTS`, `Please run 'az login'`), the notification adds **Open terminal**
(runs `az login` in a new terminal).

## Model (pure, no `vscode` import)

`planParser.ts` — plan JSON → `Plan`:
- `Plan { env, loadedAt, terraformVersion, changes: Change[], modules: ModuleDirs }`
- `Change { address, moduleAddress, modulePath: string[] /* instance keys stripped */, mode: 'managed'|'data',
  type, name, index?, action, attrs: AttrChange[], replaceBy: string[], reason? }`
- `action`: `create | update | replace | destroy | forget | read | noop` from `change.actions`
  (`["delete","create"]` and `["create","delete"]` → replace). `forget` (removed from state only, nothing deleted)
  uses the destroy colour and section, labelled "forget (state only)".
- `AttrChange { path: string, before, after, sensitive: boolean, unknown: boolean, forcesReplace: boolean }` —
  leaf diff of `before`/`after`, honouring `before_sensitive`/`after_sensitive` (show `(sensitive)`) and
  `after_unknown` (show `(known after apply)`); `forcesReplace` when the path is in `replace_paths`. Values are
  rendered as short JSON, cut at 80 chars.
- `ModuleDirs`: from the plan's `configuration` section — each `module_calls.<name>.source` that is local
  (`./` or `../`) resolves relative to its caller's folder → `Map<"lakebase", "modules/lakebase">` (nested paths
  joined with `.`). No dependency on `.terraform/modules/modules.json`.

`hclScanner.ts` — `.tf` text → `Block[]`: `{ kind: 'resource'|'data'|'module', type?, name, startLine, endLine,
headerEnd }`. Finds headers at line start (`resource "t" "n" {`, `data "t" "n" {`, `module "n" {`) and the matching
closing brace, skipping strings (incl. `${...}`), heredocs (`<<EOF`/`<<-EOF`) and comments (`#`, `//`, `/* */`).

`matcher.ts` — `(plan, files: {path, blocks}[]) → { byFile: Map<path, BlockMark[]>, orphans: Change[] }`:
- A change matches the block with the same `mode`/type/name in a `.tf` file directly inside the module's folder.
- `BlockMark { block, changes: Change[], action }` groups instances (`count`/`for_each`, a module called several
  times). Its `action` is the most severe of its changes: destroy > forget > replace > update > create > read > noop.
- `module "x"` blocks get a roll-up mark of every change whose `modulePath` starts with `x`.
- Changes with no block (removed from code, remote modules) are `orphans`.

## UI — Sixth v2 (look as in the mockup)

Colours come from the theme only (no hex), as theme colour ids contributed by the extension with defaults:
`planLens.create` → `testing.iconPassed`, `planLens.update` → `charts.yellow`, `planLens.replace` → `charts.orange`,
`planLens.destroy` → `errorForeground`, `planLens.read` → `charts.blue`. Icons are codicons: add, edit, sync, trash,
eye (read).

**Editor decorations** (`decorations.ts`), one decoration type per action:
- gutter icon on the header line (small SVGs tinted per action, one per theme kind);
- whole-block band: background = action colour at ~6% plus a 2px left border at ~70% (`isWholeLine`);
- end-of-line hint on the header (`after` text, italic, action colour): `replace — forced by location`,
  `create`, `update · 2 attributes`, `3 instances: 1 update · 2 unchanged`, module roll-up `module: 2 update ·
  1 replace`; no-op blocks get a faint `no changes` hint (setting `planLens.showUnchanged`, default true).
- Refreshed on editor change, on save (re-scan the text) and on a new plan. While a document is dirty, marks follow
  the live scan of its text.

**Hover** (`hover.ts`, `MarkdownString` with `supportHtml` + `supportThemeIcons`): header with the action icon and
name in bold, `· destroy, then create` for replace; the address in code; a table `attribute | before → after |
forces replace` (before in destroy colour struck through, after in create colour); `(sensitive)` and
`(known after apply)` muted; several instances → one sub-table per instance key (max 5, then "+ n more"). Footer
command links: Show in plan (reveals it in the sidebar), Copy address, Open log.

**Sidebar webview** (`planLens.view` in its own activity bar container, `webview/`): CSS starts from a copy of
joblauncher's `base.css` tokens (prefix `--pl-`), codicons vendored.
- Header actions: Refresh (re-plan), "…" (Load plan file, Clear plan, Open log).
- **Context bar** (`.pl-ctxbar`): environment icon, environment as a round pill with chevron (click → quick pick),
  Run | Load pill switch (`.pl-seg`).
- **Plan card** (`.pl-task`, the one filled surface): "Plan · QUAL" bold 14px, close (clear plan); sub-line root
  folder · age ("12 min ago", live) · `TF 1.14.7` (or the file name for a loaded plan); stat chips with coloured
  counts (create, update, replace, destroy; zero counts hidden); a 4px bar split by action; buttons **Re-plan
  <env>** (primary, full width) and **Log**. Running: the button reads "Planning…" with a spinner and becomes Cancel;
  the bar animates.
- Sections (`.pl-hd`, bold icon headings with a count): **Needs a look** (replace + destroy, `.pl-box` big boxes
  tinted with the action colour; sub-line: chip, "forced by `attr`" or "removed from code", module path),
  **Updates** (boxes; sub-line: changed attribute names, module path; first 5 then "+ n more"), **Creates** and
  **Reads** (compact `.pl-orow` rows with a dot and `file:line`), then a dashed `.pl-ck` line "214 unchanged · Show".
  Box title = `type.name[key]`, never the full address (in the tooltip).
- Click a box → open the file at the block's header line; orphans show a "not in code" icon and copy the address.
- Empty state: a card "No plan yet" with Run plan (primary) / Load plan file buttons and the discovered
  environments; no Terraform root → a short explanation and the `planLens.root` setting link.
- Rules from Sixth v2 hold: 13px body, names in `--pl-bright`, muted 12px secondary, mono only for attributes and
  addresses, `--pl-border` (contrast border) on every outlined/filled element for high contrast.

**Status bar**: `$(checklist) Plan QUAL · 12m · 1 replace · 2 destroy`; warning background when there is any
replace/destroy; click focuses the sidebar. Hidden with no plan.

## Code layout

```
src/extension.ts        activation, commands, wiring
src/model/planParser.ts src/model/hclScanner.ts src/model/matcher.ts   (pure, unit tested)
src/runner.ts           environments discovery + terraform processes
src/editor/decorations.ts src/editor/hover.ts
src/view/planView.ts    webview provider + messages
webview/planView.{html,css,js}  webview/base.css  webview/vendor/codicon.*
media/gutter/*.svg  media/icon.png
test/unit/*.test.mjs  test/fixtures/plan.json  test/fixtures/tf/**
test/render/render.mjs  (playwright-core 1.47.2 screenshots of the webview)
```

Build like gitland: esbuild → `dist/extension.js`, `tsc --noEmit`, `node --test`. Package with gitland's local vsce
and the Node 18 `File` shim; install with `code --install-extension`.

## Testing

- Unit (`node --test`): parser on a synthetic plan covering create, update, replace (with `replace_paths`), destroy,
  read, no-op, forget, sensitive and unknown values, `for_each` keys, a module called twice with keys; scanner on
  tricky HCL (strings with braces, `${}`, heredocs, comments, nested blocks, `dynamic`); matcher (instances grouped,
  module roll-up, orphans, nested modules).
- Render: the webview with fixture plans (empty, running, small, large, error) × dark / light / high contrast ×
  widths 260 / 360 / 500 → no horizontal overflow; compare by eye with the mockup.
- Manual: install, run a QUAL plan on DataPlatformRessources (needs `az login`), check markers in `main.tf` and
  `modules/*`, hover, sidebar clicks, cancel, and that the repo's own `.terraform` is unchanged.

## Risks

- Plan may need secrets / Azure auth the extension does not handle beyond pointing to `az login`.
- Big plans (thousands of resources): parse once per plan; scanner only on visible / opened `.tf` files.
- The first init per environment downloads providers into the extension's data dir (slow once).
