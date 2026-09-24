const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Deux sorties depuis le même src/core : l'extension VS Code et le CLI de validation. */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    alias: { open: './src/shims/open-vscode.ts' },
  },
  {
    ...common,
    entryPoints: ['src/cli/main.ts'],
    outfile: 'dist/cli.js',
    alias: { open: './src/shims/open-node.ts' },
    banner: { js: '#!/usr/bin/env node' },
  },
];

async function main() {
  // Repartir d'un dist/ propre : un bundle périmé laissé là finirait dans le VSIX.
  fs.rmSync('dist', { recursive: true, force: true });

  if (watch) {
    const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(contexts.map((c) => c.watch()));
    return;
  }

  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`Build complete (${production ? 'production' : 'development'})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
