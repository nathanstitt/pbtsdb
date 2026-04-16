/**
 * pbtsdb: Type-safe PocketBase integration with TanStack DB
 *
 * This is the full entry point including React utilities.
 * For non-React environments, use 'pbtsdb/core' instead.
 *
 * @packageDocumentation
 */

export * from './core';

export {
    createReactProvider,
    type ReactProviderResult,
} from './react.js';
