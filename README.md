# Terraform Plan Lens

See your Terraform plan **on the code**. Every `resource`, `data` and `module` block shows what the plan will do to it, and a sidebar lists the changes with the risky ones (replace, destroy) first.

## What you get

- **Gutter icon + coloured band** on each changed block: create, update, replace, destroy, read.
- **End-of-line hint** on the block header: `replace — forced by location`, `3 instances: 1 update · 2 unchanged`, `module: 1 destroy · 1 update`.
- **Hover** on the header: attribute diff (before → after), `forces replace` flags, `(sensitive)` and `(known after apply)` values.
- **Plan Lens sidebar** (same look as Gitland): environment picker, header with counts, *Needs a look* (replace / destroy, including resources removed from code), updates, creates, reads, and Re-plan / Apply at the bottom.
- **Status bar**: `Plan QUAL · 12m · 1 replace · 2 destroy`, highlighted when anything is replaced or destroyed.

## Getting a plan

- **Run plan…** picks an environment (any folder matching `environments/**/terraform.tfvars`, with its `backend.conf` when present) and runs `terraform init`, `plan -out` and `show -json`. It uses its own `TF_DATA_DIR`, so your `.terraform` folder is never touched. The saved plan file is kept only until it is applied, replaced or cleared.
- **Set environments folder…** (also in the environment picker and the empty sidebar) points Plan Lens at another folder: every subfolder with a `terraform.tfvars`, and every `*.tfvars` file in it, becomes an environment. It is saved as `planLens.environmentsFolder` in the workspace settings.
- **Load plan file…** opens a `terraform show -json` file (e.g. from a pipeline), or a binary plan file (converted with `terraform show -json`).

## Applying

Off by default: the button reads **Apply…** and points to the setting. With `planLens.allowApply` on, a plan run from Plan Lens shows **Apply <env>**. It asks for confirmation (and for the environment name when the plan replaces or destroys anything), runs `terraform apply` on **that exact saved plan** — Terraform refuses it if the state changed since — then plans again. Loaded plan files can't be applied.

Azure backends need `az login`; when the plan fails for that reason the error offers **Open terminal**.

## Targeting

To plan and apply only some changes, click the target icon in the sidebar header (or run **Plan Lens: Plan with targets…**) and pick changes or whole modules, then **Plan N targets**. Plan Lens runs `terraform plan -target=…` and shows the result. A banner lists the targets, and changes that no target picked are tagged *pulled in*: Terraform added them as dependencies, so look at them before applying. **Apply targeted** applies that exact plan, with the targets listed in the confirmation. Re-plan keeps the targets; **Full plan** drops them. After an apply, Plan Lens runs a full plan to show what is still pending. Terraform's `apply -target` can't be used with a saved plan, so targeting always goes through a new plan that you review first.

## Settings

| Setting | Default | |
|:--|:--|:--|
| `planLens.environmentsFolder` | (empty) | Folder that holds the environments; overrides the glob |
| `planLens.environmentGlob` | `environments/**/terraform.tfvars` | Where environments are found when no folder is set |
| `planLens.root` | (empty) | Terraform root; empty = parent of the environments folder |
| `planLens.terraformPath` | `terraform` | Terraform binary |
| `planLens.allowApply` | `false` | Show the Apply button after a plan run |
| `planLens.showUnchanged` | `true` | Faint "no changes" hint on untouched blocks |

Colours are theme colours (`planLens.create`, `planLens.replace`, …, and `planLens.*Background` for the bands); override them in `workbench.colorCustomizations`.

## Development

```
npm install
npm run test:unit   # model tests
npm run render      # webview screenshots in out-render/, fails on overflow
npm run package     # tf-plan-lens-<version>.vsix
```
