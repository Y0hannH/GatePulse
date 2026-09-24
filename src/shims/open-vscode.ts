import * as vscode from 'vscode';

/**
 * Replaces the `open` npm package, which @azure/identity uses to launch the browser during
 * interactive sign-in: it is ESM-only and breaks in an esbuild CJS bundle (same shim as FabricPulse).
 */
async function open(target: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(target));
}

export = open;
