import { defineConfig } from 'tsup'

export default defineConfig({
    // Entry point
    entry: ['src/index.ts', 'src/core.ts'],

    // Build-only tsconfig: silences the TS 6.0 `baseUrl` deprecation that tsup's
    // dts step injects. Kept separate from tsconfig.json so typecheck/consumers stay
    // on a config valid for both TS 5.9 and 6.0 (the `ignoreDeprecations` value is
    // version-specific and would break TS 5.9).
    tsconfig: 'tsconfig.build.json',

    // Output format: ESM only (modern)
    format: ['esm'],

    // Output directory
    outDir: 'dist',

    // Generate TypeScript declaration files
    dts: true,

    // Support JSX/React for provider.tsx
    jsx: 'preserve',

    // Clean output directory before build
    clean: true,

    // Generate sourcemaps for debugging
    sourcemap: true,

    // Target modern environments
    target: 'es2020',

    // External dependencies (don't bundle peer dependencies)
    external: [
        'pocketbase',
        '@tanstack/db',
        '@tanstack/query-db-collection',
        '@tanstack/react-query',
        '@tanstack/react-db',
        'react',
        'react-dom',
    ],

    // Minify output
    minify: false, // Keep readable for library consumers

    // Tree shaking
    treeshake: true,

    // Split output by chunk (better for tree-shaking in consumers)
    splitting: true,

    // Bundle
    bundle: true,
})
