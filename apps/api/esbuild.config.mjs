// Bundle mínimo para Lambda (Node 20). Mantener el zip pequeño acelera cold starts.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/lambda.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/lambda.mjs',
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  external: [
    // AWS SDK v3 ya viene en el runtime de Lambda Node 20.
    '@aws-sdk/*',
  ],
});

console.log('lambda bundle built → dist/lambda.mjs');
