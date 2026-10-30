# Changelog

## 0.4.0

- **Values and completions in module files**: locals, variables, `for_each` and outputs of the modules the root calls show their value for the environment — per instance (`= "10.1.1.0/24"  · subnet["app"] (+2)`), every instance in the hover. Evaluate selection works there too.
- **Modules outside the root** (`source = "../modules/vm"`): their files get the plan too — band, hint, hover, refactor quick fix, preview on save — and the sidebar opens them.
- Apply off? The Apply button offers to turn it on for the workspace, then asks its usual confirmation.
- **New look**: a plan card with stat pills and a bar per change (the riskier the taller), bold icon headings, outlined boxes with icon tiles, an Apply bar; values as soft pills in the editor; a new icon.
- **Preview your edit on save**: after a plan, saving plans just the edited blocks (`-target`, no refresh, no lock: read only) and says on the edited lines what that would do — `◆ preview: replace — forced by location`, `⟳ forces replacement`, `~ "LRS" → "GRS"`. Unapplied moved blocks are handled.
- **Completions from your data**: map keys and object fields from the evaluated values after `local.x.`, `local.x["`, `var.x.`, `each.value.`.
- **Values as you write**: locals, variables, `for_each` / `count` and outputs show what they evaluate to for the environment, at the end of the line and in the hover; **Evaluate selection** for any expression. Terraform's own evaluator on Plan Lens's own copy with a local empty state — the real state is never read or locked.
- **Settings page** in the sidebar (gear): sections shown / discreet / hidden, refactor autopilot, plan on the code, values, Apply, binary, environments. *Changed outside Terraform* and *Reads* are discreet by default.
- The rest of the plan: **drift** (*Changed outside Terraform*), **imports** (an import replaced right away is flagged in *Needs a look*), **moved** objects (`new ← old`) and **output** changes, in the sidebar, the end-of-line hints and the hover. Import-only plans can be applied.
- Runs terraform only in **trusted workspaces** (loading a plan JSON works everywhere).
- **OpenTofu**: `tofu` is used when it is the only binary installed (`planLens.terraformPath` now defaults to empty).
- Login hints beyond Azure: AWS (`aws sso login`, `aws configure`) and Google Cloud (`gcloud auth application-default login`).
- **Refactor autopilot**: destroys that are really objects moved to a new address (renamed, moved into a module, `count` → `for_each`, module renamed) are paired with their create by type and values and shown in a *Looks like a refactor* card. **Write moved.tf** adds the `moved` blocks (whole modules folded into one), **Write & re-plan** shows the destroys gone. Ambiguous pairs are never ticked for you. In the editor: an end-of-line hint, a quick fix and a hover link on blocks that look moved; after a re-plan, moved objects count as `N moved`.
- Works without the `environments/` convention: every Terraform folder in the workspace (not a local module) can be planned as it is, so single-root projects, monorepos with several roots and multi-root workspaces need no setup. With envs in several roots, their names get the root in front (`infra/QUAL`).
- Terraform workspaces: local ones (`terraform.tfstate.d/`) are listed as `<folder>:<workspace>`; **Find workspaces…** lists the ones of a remote backend. Plans run with `TF_WORKSPACE`, leaving the workspace selected in your terminal alone.
- A plan blocked by a locked remote state (left by a stopped or crashed run) now offers **Force unlock…**: it shows who holds the lock and since when, then runs `terraform force-unlock` and plans again once you confirm.
- Fixed: switching environment (e.g. right after an Apply, which re-plans the same env) left the sidebar on the previous env until the new plan finished. While a run goes, the header now names the env being planned, and a loaded plan from another env is hidden instead of shown under it.

## 0.3.0

- Targeting: pick changes or whole modules in the sidebar (or **Plan with targets…**) to plan with `-target`, review what Terraform pulled in as dependencies, then **Apply targeted**.
- The log is a read-only **Plan Lens** terminal with terraform's own colours (the Output panel printed the raw `[0m[1m` codes). It keeps its history when closed and reopened.
- With `planLens.allowApply` off, a run plan still shows **Apply…**; it says how to turn Apply on instead of the button being missing.

## 0.2.0

- Sidebar restyled after Gitland: header card with `+2 ~5 ±2 −3`, dashed collapsible sections, dense rows with Terraform's symbols, actions pinned at the bottom.
- Apply (opt-in, `planLens.allowApply`): applies the saved plan after confirmation, then re-plans.
- `planLens.environmentsFolder` and **Set environments folder…**: read environments from any folder, including loose `*.tfvars` files.

## 0.1.0

- First version: run or load a plan, editor markers and hover, Sixth-styled sidebar, status bar.
