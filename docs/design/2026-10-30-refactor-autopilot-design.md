# Refactor autopilot — design

**Goal.** When a plan destroys objects and creates the same objects under new addresses (rename, move into a module,
`count` → `for_each`, module renamed), Plan Lens finds the pairs, writes the `moved` blocks, re-plans, and shows the
destroys gone. Audience: experienced Terraform users refactoring real infrastructure.

**Rules.** Only `moved` blocks (no `state mv`): reviewable in git, reverted by deleting them. Never pair silently what
could be wrong: ambiguous pairs are shown unticked. Same resource type only (Terraform can't move across types).

## Matching (`src/model/refactor.ts`, pure)

- Candidates: managed `destroy` and `create` changes of the same type.
- Values: the destroy's `before` and the create's known `after`, flattened to leaves; sensitive and unknown leaves are
  left out, so are null/empty ones. Kept in the extension host only (never posted to the webview).
- Score = weighted share of the create's leaves equal in the destroy. A leaf value held by every object of the type
  weighs 0 (it tells nothing apart); others weigh 1. Pairs need score ≥ 0.75.
- Greedy, best score first (ties: same resource name and type). A pair is *ambiguous* when another free candidate of
  either side scores within 0.02, or when it rests on fewer than 2 telling values under another resource name.
- Folding: when every destroy under a module instance pairs, with the same relative address, into one other module
  instance, the pairs fold into one module move (`module.old` → `module.new`, `module.inst[0]` → `module.inst["i0"]`).

## Writing

- Always `<root>/moved.tf`, full addresses (checked with Terraform 1.14: keyed module instances and resources inside
  them are valid from the root). Appended through a WorkspaceEdit (undoable), saved, opened beside.
- A `from` already in a `moved` block of the root is skipped.
- The webview sends the picked pair ids; the host only writes pairs it computed itself.

## UI

- Sidebar: a "Looks like a refactor" card above *Needs a look*: `N destroys can be moves`, one row per move
  (from → to, match %, *ambiguous*), checkboxes, **Write moved blocks** and **Write & re-plan**.
- Destroy rows that pair show *moves to …*; after a re-plan, moved objects count in the quiet line (`11 moved`), and a
  notification says `destroys 11 → 0`.
- Editor: the create block's hint says `looks moved from X`; a quick fix (and a hover link) adds that one moved block.

## Testing

Unit tests on a real plan (`test/fixtures/refactor-plan.json`, made with `terraform_data`): rename into module,
count → for_each, module rename and module count → for_each fold, unrelated destroy/create stay unpaired, ties marked
ambiguous, HCL output. End-to-end: write the blocks into the scenario and re-plan with real Terraform: 0 destroys.
Render check: the card in dark/light/high contrast at 260/360/500 px.
