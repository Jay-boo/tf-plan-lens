# Terraform Plan Lens

See your Terraform plan **on the code**. Every `resource`, `data` and `module` block shows what the plan will do to it, and a sidebar lists the changes with the risky ones (replace, destroy) first.

## What you get

- **Gutter icon + coloured band** on each changed block: create, update, replace, destroy, read.
- **End-of-line hint** on the block header: `replace — forced by location`, `3 instances: 1 update · 2 unchanged`, `module: 1 destroy · 1 update`.
- **Hover** on the header: attribute diff (before → after), `forces replace` flags, `(sensitive)` and `(known after apply)` values.
- **Plan Lens sidebar** (same look as Gitland): environment picker, header with counts, *Needs a look* (replace / destroy, including resources removed from code), updates, creates, reads, and Re-plan / Apply at the bottom.
- **The rest of the plan**: *Changed outside Terraform* (drift since the last apply), *Imports* (an import that is then replaced or destroyed goes to *Needs a look*), *Moved* (`new ← old`), and *Outputs* (before → after, never a sensitive value). In the editor: `import`, `moved from …` hints, and drift in the hover.
- **Status bar**: `Plan QUAL · 12m · 1 replace · 2 destroy`, highlighted when anything is replaced or destroyed.

## Getting a plan

- **Run plan…** picks an environment and runs `terraform init`, `plan -out` and `show -json`. Environments come from:
  - tfvars files matching `environments/**/terraform.tfvars` (with the `backend.conf` next to them), each planning the folder above `environments/`;
  - every other **Terraform folder** in the workspace, with no setup: a folder with `.tf` files that is not a local module of another folder (nor under `modules/`). It plans as it is, so its `terraform.tfvars` and `*.auto.tfvars` apply. Monorepos with several roots and multi-root workspaces get one entry per root;
  - its **workspaces**: local ones (`terraform.tfstate.d/`) show up by themselves as `infra:prod`; for a remote backend, **Find workspaces…** (in the environment picker or the view menu) runs `terraform workspace list` once and remembers them. A workspace env runs with `TF_WORKSPACE`, so the workspace selected in your terminal doesn't change. It uses its own `TF_DATA_DIR`, so your `.terraform` folder is never touched. The saved plan file is kept only until it is applied, replaced or cleared.
- **Set environments folder…** (also in the environment picker and the empty sidebar) points Plan Lens at another folder: every subfolder with a `terraform.tfvars`, and every `*.tfvars` file in it, becomes an environment. It is saved as `planLens.environmentsFolder` in the workspace settings.
- **Load plan file…** opens a `terraform show -json` file (e.g. from a pipeline), or a binary plan file (converted with `terraform show -json`).

## Refactoring without recreating anything

Rename a resource, move it into a module, switch `count` to `for_each` or rename a module, and Terraform plans a destroy
and a create: the object would be recreated. Plan Lens spots those pairs — same type, same values, new address — and
shows a **Looks like a refactor** card above the risky changes:

- each move with its match (`100%`), whole module moves folded into one (`module.old → module.new`);
- **ambiguous** pairs (another object matches about as well) are shown but not ticked;
- **Write moved.tf** appends the ticked `moved` blocks to `moved.tf` in the Terraform root (one undoable edit, opened
  beside); **Write & re-plan** then plans again and tells you `destroys 11 → 1`.

In the editor, a block that looks moved says so at the end of its line (`looks moved from terraform_data.lake`), with a
quick fix (Ctrl+.) and a hover link to add just that moved block. Values that every object of a type shares (a common
`location`) don't count as a match, sensitive values are never compared, and nothing is written to the state: delete a
moved block to undo it.

## Values as you write

Plan Lens shows what the environment's root module evaluates to, like a debugger's inline values: `locals` (`= "rg-qual-data"`), `variable`s, `for_each` / `count` (`→ 3 instances: "app", "db", "pe"`) and outputs, at the end of their line, in full in the hover, and following your typing. Select any expression and run **Plan Lens: Evaluate selection** (editor context menu) to see its value. Errors are Terraform's own (`⚠ Reference to undeclared local value`).

It is Terraform's evaluator (`terraform console`) with the environment's variables, run on Plan Lens's own copy of the root and its local modules with a **local, empty state**: console locks the state it reads, so the team's remote state is never touched. Attributes only the cloud knows show `(known after apply)`; sensitive values are never shown. The first values of a project wait for a `terraform init` of that copy (providers come from a shared plugin cache).

## Preview your edit on save

Once an environment has been planned here, saving a `.tf` file plans **just the blocks you edited** since that plan and says on the edited lines what it would do — before anyone runs a full plan:

```hcl
resource "azurerm_storage_account" "lake" {   ◆ preview: replace — forced by location
  location = "francecentral"                  ⟳ forces replacement
  sku      = "Standard_GRS"                   ~ "Standard_LRS" → "Standard_GRS"
```

It is `terraform plan -target=… -refresh=false -lock=false`: read only, it never takes the state lock (your teammates are never blocked), never refreshes the whole state, and is never applied. Hover the block for the attribute table. The preview goes when you edit the block again or when a full plan comes in. Blocks in a module are previewed through the module calls of the last plan; moved blocks not applied yet are taken in as Terraform asks.

## Completions from your data

Because Plan Lens knows the values, it completes what the language server can't: `local.subnets.` / `local.subnets["` → `app`, `db`, `pe`; `each.value.` → the fields of the block's `for_each` elements; `var.config.` → the fields of the variable, each with its value for the environment.

## Settings page

The gear in the sidebar header opens Plan Lens's settings: what each sidebar section shows (*shown*, *discreet* — one faint line you open on click — or *hidden*; *Changed outside Terraform* and *Reads* are discreet by default), the refactor autopilot, the plan on the code, the "no changes" hints, values as you write, Apply (per workspace), the Terraform binary and where environments come from. They are ordinary VS Code settings (`planLens.*`).

## Applying

Off by default: the button reads **Apply…** and points to the setting. With `planLens.allowApply` on, a plan run from Plan Lens shows **Apply <env>**. It asks for confirmation (and for the environment name when the plan replaces or destroys anything), runs `terraform apply` on **that exact saved plan** — Terraform refuses it if the state changed since — then plans again. Loaded plan files can't be applied.

When a plan fails on an expired or missing cloud login, the error offers the login command in a terminal: `az login`, `aws sso login` / `aws configure`, or `gcloud auth application-default login`.

## Trust and OpenTofu

Terraform runs code from the workspace (providers, modules), so Plan Lens runs it only in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust); in restricted mode you can still load a plan JSON. With `planLens.terraformPath` empty, Plan Lens runs `terraform`, or `tofu` when only OpenTofu is installed.

## Targeting

To plan and apply only some changes, click the target icon in the sidebar header (or run **Plan Lens: Plan with targets…**) and pick changes or whole modules, then **Plan N targets**. Plan Lens runs `terraform plan -target=…` and shows the result. A banner lists the targets, and changes that no target picked are tagged *pulled in*: Terraform added them as dependencies, so look at them before applying. **Apply targeted** applies that exact plan, with the targets listed in the confirmation. Re-plan keeps the targets; **Full plan** drops them. After an apply, Plan Lens runs a full plan to show what is still pending. Terraform's `apply -target` can't be used with a saved plan, so targeting always goes through a new plan that you review first.

## Settings

| Setting | Default | |
|:--|:--|:--|
| `planLens.environmentsFolder` | (empty) | Folder that holds the environments; overrides the glob |
| `planLens.environmentGlob` | `environments/**/terraform.tfvars` | Where environments are found when no folder is set |
| `planLens.root` | (empty) | Terraform root; empty = parent of the environments folder |
| `planLens.terraformPath` | (empty) | Terraform or OpenTofu binary; empty = `terraform`, else `tofu` |
| `planLens.allowApply` | `false` | Show the Apply button after a plan run |
| `planLens.showUnchanged` | `true` | Faint "no changes" hint on untouched blocks |
| `planLens.inlineValues` | `true` | Values as you write |
| `planLens.preview` | `true` | Preview edited blocks on save |
| `planLens.completions` | `true` | Completions from the evaluated values |
| `planLens.editorMarkers` | `true` | Gutter icon, band and hint on changed blocks |
| `planLens.refactor` | `true` | Refactor autopilot |
| `planLens.sidebar.drift` / `.reads` | `discreet` | `shown`, `discreet` or `hidden` |
| `planLens.sidebar.imports` / `.moved` / `.outputs` | `shown` | `shown`, `discreet` or `hidden` |

Colours are theme colours (`planLens.create`, `planLens.replace`, …, and `planLens.*Background` for the bands); override them in `workbench.colorCustomizations`.

## Development

```
npm install
npm run test:unit   # model tests
npm run render      # webview screenshots in out-render/, fails on overflow
npm run package     # tf-plan-lens-<version>.vsix
```
