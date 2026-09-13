const __importDefault =
    (this && this.__importDefault) || (mod => (mod?.__esModule ? mod : { default: mod }))
Object.defineProperty(exports, '__esModule', { value: true })
exports.generateTsSchema = generateTsSchema
const utils_1 = require('../utils')
const field_handlers_1 = require('./field-handlers')
const config_json_1 = __importDefault(require('../../config.json'))
function generateTsSchema(
    includeSystemCollections = config_json_1.default.tsSchema.includeSystemCollections
) {
    const collections = $app.findAllCollections().filter(c => includeSystemCollections || !c.system)
    const collectionInterfaces = getCollectionInterfaces(collections)
    const pbTsSchema = getPbTsSchema(collections)
    return (0, utils_1.format)(collectionInterfaces + pbTsSchema)
}
function getCollectionInterfaces(collections) {
    let _a
    const UNIQUE_IDENTIFIER_KEY = `declare const uniqueIdentifier: unique symbol`
    const UNIQUE_IDENTIFIER = `
/**
 * This is a unique identifier to help TypeScript differentiate this interface from others sharing the same properties.
 * Refer to https://github.com/satohshi/pocketbase-ts#dealing-with-tables-with-exactly-the-same-properties for more information.
 */
readonly [uniqueIdentifier]: unique symbol
`
    const collectionIdToNameMap = new Map(
        collections.map(collection => [collection.id, collection.name])
    )
    const fieldSets = []
    const overrides = config_json_1.default.tsSchema.overrides
    let collectionInterfaces = ''
    for (const collection of collections) {
        const fields = new Set()
        collectionInterfaces += `export interface ${(0, utils_1.toPascalCase)(collection.name)} {\n`
        for (const fieldOptions of collection.fields) {
            const fieldType = fieldOptions.type()
            let schema
            switch (fieldType) {
                case 'text':
                    schema = (0, field_handlers_1.textFieldSchema)(fieldOptions)
                    break
                case 'password':
                    schema = (0, field_handlers_1.passwordFieldSchema)(fieldOptions)
                    break
                case 'editor':
                    schema = (0, field_handlers_1.editorFieldSchema)(fieldOptions)
                    break
                case 'number':
                    schema = (0, field_handlers_1.numberFieldSchema)(fieldOptions)
                    break
                case 'bool':
                    schema = (0, field_handlers_1.boolFieldSchema)(fieldOptions)
                    break
                case 'email':
                    schema = (0, field_handlers_1.emailFieldSchema)(fieldOptions)
                    break
                case 'url':
                    schema = (0, field_handlers_1.urlFieldSchema)(fieldOptions)
                    break
                case 'date':
                    schema = (0, field_handlers_1.dateFieldSchema)(fieldOptions)
                    break
                case 'autodate':
                    schema = (0, field_handlers_1.autodateFieldSchema)(fieldOptions)
                    break
                case 'select':
                    schema = (0, field_handlers_1.selectFieldSchema)(fieldOptions)
                    break
                case 'file':
                    schema = (0, field_handlers_1.fileFieldSchema)(fieldOptions)
                    break
                case 'relation':
                    schema = (0, field_handlers_1.relationFieldSchema)(
                        Object.assign(Object.assign({}, fieldOptions), {
                            collectionName: collectionIdToNameMap.get(fieldOptions.collectionId),
                        })
                    )
                    break
                case 'json':
                    schema = (0, field_handlers_1.jsonFieldSchema)(
                        Object.assign(Object.assign({}, fieldOptions), {
                            override:
                                (_a =
                                    overrides === null || overrides === void 0
                                        ? void 0
                                        : overrides[collection.name]) === null || _a === void 0
                                    ? void 0
                                    : _a[fieldOptions.name],
                        })
                    )
                    break
                case 'geoPoint':
                    schema = (0, field_handlers_1.geoPointSchema)(fieldOptions)
                    break
                default:
                    fieldType
            }
            const [typeDef, docs] = schema
            collectionInterfaces += docs ? `${docs}\n${typeDef}\n` : `${typeDef}\n`
            fields.add(typeDef)
        }
        if (fieldSets.some(set => (0, utils_1.haveSameValues)(set, fields))) {
            if (!collectionInterfaces.startsWith(UNIQUE_IDENTIFIER_KEY)) {
                collectionInterfaces = `${UNIQUE_IDENTIFIER_KEY}\n\n${collectionInterfaces}`
            }
            collectionInterfaces += UNIQUE_IDENTIFIER
        }
        collectionInterfaces += '}\n\n'
        fieldSets.push(fields)
    }
    return collectionInterfaces
}
function getPbTsSchema(collections) {
    const collectionToRelationMap = getRelationMap(collections)
    let schemaText = `
/**
 * Commented-out back-relations are what will be inferred by pocketbase-ts from the forward relations.
 *
 * The "UNIQUE index constraint" case is automatically handled by this hook,
 * but if you want to make a back-relation non-nullable, you can uncomment it and remove the "?".
 *
 * See [here](https://github.com/satohshi/pocketbase-ts#back-relations) for more information.
 */
export type Schema = {
`
    for (const [collection, relations] of collectionToRelationMap) {
        schemaText += `${collection}: {\n`
        schemaText += `type: ${(0, utils_1.toPascalCase)(collection)}\n`
        if (relations.length) {
            schemaText += `relations: {\n`
            for (const relation of relations) {
                schemaText += `${relation}\n`
            }
            schemaText += `}\n`
        }
        schemaText += `}\n`
    }
    schemaText += `}\n`
    return schemaText
}
function getRelationMap(collections) {
    const collectionIdToNameMap = new Map(
        collections.map(collection => [collection.id, collection.name])
    )
    const relationMap = new Map(collections.map(c => [c.name, []]))
    for (const collection of collections) {
        const fieldsWithUniqueIndex = new Set(
            collection.indexes
                .filter(index => index.includes('UNIQUE') && !index.includes(','))
                .map(index => /^CREATE UNIQUE.+\(`?([^`\s]+).*\).*/.exec(index)[1])
        )
        for (const field of collection.fields) {
            if (field.type() === 'relation') {
                const { name, collectionId, required, isMultiple } = field
                const hasUniqueConstraint = fieldsWithUniqueIndex.has(name)
                const relatedCollectionName = collectionIdToNameMap.get(collectionId)
                const forwardRelation = `${name}${!required ? '?' : ''}: ${(0, utils_1.toPascalCase)(relatedCollectionName)}${isMultiple() ? '[]' : ''}`
                relationMap.get(collection.name).push(forwardRelation)
                const backRelation = `${collection.name}_via_${name}?: ${(0, utils_1.toPascalCase)(collection.name)}${hasUniqueConstraint ? '' : '[]'}`
                relationMap.get(relatedCollectionName).push(backRelation)
            }
        }
    }
    return relationMap
}
