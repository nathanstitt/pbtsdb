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
export {
    BasicIndex,
    BTreeIndex,
    createEffect,
    materialize,
    ReverseIndex,
    toArray,
} from '@tanstack/db'
export type { RecordSubscribeOptions } from 'pocketbase'
export {
    type CreateCollectionFactoryOptions,
    createCollection,
    type PbCollection,
    type PbCollectionView,
} from './collection'
export { type Logger, resetLogger, setLogger } from './logger'
export type {
    CreateCollectionOptions,
    ExcludeUndefined,
    ExpandPath,
    ExtractRecordType,
    ExtractRelations,
    OmittableFields,
    RelationAsCollection,
    RelationsConfig,
    SchemaDeclaration,
} from './types'
export { newRecordId } from './util'
