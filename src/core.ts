/**
 * pbtsdb core: Type-safe PocketBase integration with TanStack DB
 *
 * This entry point has no React dependency and can be used in Node.js,
 * server-side, or any non-React environment.
 *
 * @packageDocumentation
 */

export { createCollection } from './collection';

export { setLogger, resetLogger, type Logger } from './logger';

export { newRecordId } from './util';

export { toArray, createEffect, BasicIndex, BTreeIndex, ReverseIndex } from '@tanstack/db';
export type {
    DeltaEvent,
    DeltaType,
    EffectConfig,
    EffectContext,
    IndexConstructor,
} from '@tanstack/db';

export type {
    SchemaDeclaration,
    CreateCollectionOptions,
    WithExpand,
    ExtractRecordType,
    ExtractRelations,
    ParseExpandFields,
    ExcludeUndefined,
    RelationAsCollection,
    OmittableFields,
} from './types';
