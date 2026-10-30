# Changelog

## Unreleased

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
