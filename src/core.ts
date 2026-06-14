/**
 * pbtsdb core: Type-safe PocketBase integration with TanStack DB
 *
 * This entry point has no React dependency and can be used in Node.js,
 * server-side, or any non-React environment.
 *
 * @packageDocumentation
 */

export type {
    DeltaEvent,
    DeltaType,
    EffectConfig,
    EffectContext,
    IndexConstructor,
} from '@tanstack/db'
export { BasicIndex, BTreeIndex, createEffect, ReverseIndex, toArray } from '@tanstack/db'
export { createCollection } from './collection'
export { type Logger, resetLogger, setLogger } from './logger'
export type {
    CreateCollectionOptions,
    ExcludeUndefined,
    ExtractRecordType,
    ExtractRelations,
    OmittableFields,
    ParseExpandFields,
    RelationAsCollection,
    SchemaDeclaration,
    WithExpand,
} from './types'
export { newRecordId } from './util'
