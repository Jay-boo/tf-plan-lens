// The settings the settings page (an editor tab) shows and changes. One list: the page is drawn from it, the extension only
// accepts changes that fit it, and a test checks it against package.json. Pure: no vscode.

export type Visibility = 'shown' | 'discreet' | 'hidden';
export const VISIBILITY: Visibility[] = ['shown', 'discreet', 'hidden'];

export interface SettingDef {
  key: string;
  group: 'Appearance' | 'Sidebar' | 'Editor' | 'Plans and apply';
  label: string;
  help: string;
  /** choice: one of `options`; colors: 2–3 hex colours, comma separated. */
  type: 'visibility' | 'boolean' | 'string' | 'choice' | 'colors';
  options?: { value: string; label: string }[];
  default: Visibility | boolean | string;
  /** Saved for this workspace (folders, apply) rather than for the user. */
  workspace?: boolean;
  placeholder?: string;
}

/** Accent gradients (three stops); mono follows the theme's own accent, custom the user's colours. */
export const ACCENTS: Record<string, string[]> = {
  aurora: ['#8b5cf6', '#3b82f6', '#06b6d4'],
  sunset: ['#f43f5e', '#f97316', '#f59e0b'],
  forest: ['#10b981', '#14b8a6', '#06b6d4'],
  terraform: ['#7b42bc', '#5c4ee5', '#a87ff0'],
};

/** The 2–3 hex colours of a custom accent (`#8b5cf6, #06b6d4`), or undefined when they don't parse. */
export function parseColors(s: string): string[] | undefined {
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^#[0-9a-f]{6}$/i.test(p)) ? parts : undefined;
}

export const SETTINGS: SettingDef[] = [
  { key: 'style.accent', group: 'Appearance', label: 'Accent', help: 'The gradient of the header line, the primary buttons and the switches.', type: 'choice', default: 'aurora',
    options: [{ value: 'aurora', label: 'Aurora' }, { value: 'sunset', label: 'Sunset' }, { value: 'forest', label: 'Forest' }, { value: 'terraform', label: 'Terraform' }, { value: 'mono', label: 'Mono' }, { value: 'custom', label: 'Custom' }] },
  { key: 'style.customColors', group: 'Appearance', label: 'Custom colours', help: 'With the Custom accent: 2 or 3 hex colours, comma separated.', type: 'colors', default: '#8b5cf6, #06b6d4', placeholder: '#8b5cf6, #06b6d4' },
  { key: 'style.corners', group: 'Appearance', label: 'Corners', help: 'How round boxes, badges and buttons are.', type: 'choice', default: 'sharp',
    options: [{ value: 'sharp', label: 'Sharp' }, { value: 'soft', label: 'Soft' }, { value: 'round', label: 'Round' }] },
  { key: 'style.density', group: 'Appearance', label: 'Density', help: 'Room around rows and cards.', type: 'choice', default: 'comfortable',
    options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }] },
  { key: 'style.motion', group: 'Appearance', label: 'Motion', help: 'Subtle: a new plan slides in, nothing loops. Full: the header rule drifts slowly, rules draw in, hovered entries extend their mark. Off: still.', type: 'choice', default: 'subtle',
    options: [{ value: 'subtle', label: 'Subtle' }, { value: 'full', label: 'Full' }, { value: 'off', label: 'Off' }] },
  { key: 'sidebar.drift', group: 'Sidebar', label: 'Changed outside Terraform', help: 'Drift since the last apply. Discreet: one faint line you can open.', type: 'visibility', default: 'discreet' },
  { key: 'sidebar.imports', group: 'Sidebar', label: 'Imports', help: 'Objects import blocks bring under Terraform.', type: 'visibility', default: 'shown' },
  { key: 'sidebar.moved', group: 'Sidebar', label: 'Moved', help: 'Objects moved blocks move to a new address.', type: 'visibility', default: 'shown' },
  { key: 'sidebar.reads', group: 'Sidebar', label: 'Reads', help: 'Data sources read during the plan.', type: 'visibility', default: 'discreet' },
  { key: 'sidebar.outputs', group: 'Sidebar', label: 'Outputs', help: 'Outputs the plan changes (sensitive values never shown).', type: 'visibility', default: 'shown' },
  { key: 'refactor', group: 'Sidebar', label: 'Refactor autopilot', help: 'Spot destroys that are moves, offer moved blocks (sidebar card, editor hints, quick fix).', type: 'boolean', default: true },
  { key: 'editorMarkers', group: 'Editor', label: 'Plan on the code', help: 'Gutter icon, coloured band and end-of-line hint on changed blocks.', type: 'boolean', default: true },
  { key: 'showUnchanged', group: 'Editor', label: '"No changes" hints', help: 'A faint hint on blocks the plan leaves alone.', type: 'boolean', default: true },
  { key: 'preview', group: 'Editor', label: 'Preview edits on save', help: 'After a plan, saving a block plans just that block (no refresh, no lock) and says on the edited lines what it would do: update, replace…', type: 'boolean', default: true },
  { key: 'completions', group: 'Editor', label: 'Completions from your data', help: 'Complete map keys and object fields from the evaluated values: local.x["…"], each.value.…, var.x.…', type: 'boolean', default: true },
  { key: 'inlineValues', group: 'Editor', label: 'Values as you write', help: 'What locals, variables, for_each and outputs evaluate to, for the environment (terraform console on a copy, never the real state).', type: 'boolean', default: true },
  { key: 'allowApply', group: 'Plans and apply', label: 'Apply from Plan Lens', help: 'Apply the exact plan shown, after a confirmation. For this workspace only.', type: 'boolean', default: false, workspace: true },
  { key: 'terraformPath', group: 'Plans and apply', label: 'Terraform binary', help: 'Empty: terraform, or tofu when only OpenTofu is installed.', type: 'string', default: '', placeholder: 'terraform' },
];

/** A change the settings page asked for, checked against the list; undefined when it does not fit. */
export function validSetting(key: unknown, value: unknown): { def: SettingDef; value: Visibility | boolean | string } | undefined {
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) return undefined;
  if (def.type === 'visibility') return VISIBILITY.includes(value as Visibility) ? { def, value: value as Visibility } : undefined;
  if (def.type === 'boolean') return typeof value === 'boolean' ? { def, value } : undefined;
  if (def.type === 'choice') return def.options!.some((o) => o.value === value) ? { def, value: value as string } : undefined;
  if (def.type === 'colors') return typeof value === 'string' && parseColors(value) ? { def, value: parseColors(value)!.join(', ') } : undefined;
  return typeof value === 'string' && value.length < 1024 && !/[\r\n\0]/.test(value) ? { def, value: value.trim() } : undefined;
}

/** The sidebar's look from the style.* values: gradient stops (none for mono), corner radius, density, motion. */
export function styleOf(get: (key: string) => unknown): { colors?: string[]; radius: number; density: string; motion: string } {
  const accent = String(get('style.accent') ?? 'aurora');
  const colors = accent === 'mono' ? undefined : accent === 'custom' ? parseColors(String(get('style.customColors') ?? '')) ?? ACCENTS.aurora : ACCENTS[accent] ?? ACCENTS.aurora;
  const radius = ({ sharp: 3, soft: 6, round: 10 } as Record<string, number>)[String(get('style.corners'))] ?? 3;
  return { colors: colors && (colors.length === 2 ? [colors[0], colors[1], colors[0]] : colors), radius, density: String(get('style.density') ?? 'comfortable'), motion: String(get('style.motion') ?? 'subtle') };
}
