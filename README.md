# Terraform Plan Lens

See your Terraform plan **on the code**. Every `resource`, `data` and `module` block shows what the plan will do to it, and a sidebar lists the changes with the risky ones (replace, destroy) first.

## What you get

- **Gutter icon + coloured band** on each changed block: create, update, replace, destroy, read.
- **End-of-line hint** on the block header: `replace — forced by location`, `3 instances: 1 update · 2 unchanged`, `module: 1 destroy · 1 update`.
- **Hover** on the header: attribute diff (before → after), `forces replace` flags, `(sensitive)` and `(known after apply)` values.
- **Plan Lens sidebar**: environment picker, plan card with counts, *Needs a look* (replace / destroy, including resources removed from code), updates, creates, reads.
- **Status bar**: `Plan QUAL · 12m · 1 replace · 2 destroy`, highlighted when anything is replaced or destroyed.

## Getting a plan

- **Run plan…** picks an environment (any folder matching `environments/**/terraform.tfvars`, with its `backend.conf` when present) and runs `terraform init`, `plan -out` and `show -json`. It uses its own `TF_DATA_DIR`, so your `.terraform` folder is never touched, and the plan file is deleted right after. It **never runs apply**.
- **Load plan file…** opens a `terraform show -json` file (e.g. from a pipeline), or a binary plan file (converted with `terraform show -json`).

Azure backends need `az login`; when the plan fails for that reason the error offers **Open terminal**.

## Settings

| Setting | Default | |
|:--|:--|:--|
| `planLens.environmentGlob` | `environments/**/terraform.tfvars` | Where environments are found |
| `planLens.root` | (empty) | Terraform root; empty = parent of the environments folder |
| `planLens.terraformPath` | `terraform` | Terraform binary |
| `planLens.showUnchanged` | `true` | Faint "no changes" hint on untouched blocks |

Colours are theme colours (`planLens.create`, `planLens.replace`, …, and `planLens.*Background` for the bands); override them in `workbench.colorCustomizations`.

## Development

```
npm install
npm run test:unit   # model tests
npm run render      # webview screenshots in out-render/, fails on overflow
npm run package     # tf-plan-lens-<version>.vsix
```
