import { spawn } from 'child_process';

/** CLI counterpart of open-vscode.ts: launches the default browser without the ESM-only `open` package. */
async function open(target: string): Promise<void> {
  console.log(`\nOpening browser for sign-in. If nothing opens, visit:\n${target}\n`);
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', target.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
}

export = open;
