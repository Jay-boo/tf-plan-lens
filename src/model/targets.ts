// Resource targeting (terraform plan -target). Pure: nothing here may import 'vscode'.

/** Whether `-target=target` selects `address`: the same address, one of its instances, or anything inside a module. */
export function covers(target: string, address: string): boolean {
  return address === target || address.startsWith(`${target}.`) || address.startsWith(`${target}[`);
}

/** Targets without duplicates or any that another one already covers (picking a module makes its resources redundant). */
export function compactTargets(targets: string[]): string[] {
  const unique = [...new Set(targets)];
  return unique.filter((t) => !unique.some((o) => o !== t && covers(o, t)));
}

/** `-target=` flags; refuses anything that is not a resource or module address (the addresses come from the webview). */
export function targetArgs(targets: string[]): string[] {
  return targets.map((t) => {
    if (!/^[A-Za-z]/.test(t)) throw new Error(`Not a Terraform address: ${t}`);
    return `-target=${t}`;
  });
}
