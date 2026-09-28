import {
    type FieldPath,
    IR,
    type ParsedOrderBy,
    parseOrderByExpression,
    parseWhereExpression,
} from '@tanstack/db'

type BasicExpression<T = unknown> = IR.BasicExpression<T>

export function escapeValue(value: unknown): string {
    if (value === null) {
        return 'null'
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
    }
    if (typeof value === 'number') {
        return value.toString()
    }
    if (typeof value === 'string') {
        return `"${value.replace(/"/g, '\\"')}"`
    }
    if (value instanceof Date) {
        return `"${value.toISOString()}"`
    }
    if (Array.isArray(value)) {
        return `[${value.map(escapeValue).join(',')}]`
    }
    return `"${String(value)}"`
}

function fieldPathToString(path: FieldPath): string {
    return path.join('.')
}

const NEGATED_OPERATORS: Record<string, string> = {
    eq: 'neq',
    neq: 'eq',
    gt: 'lte',
    gte: 'lt',
    lt: 'gte',
    lte: 'gt',
    in: 'notIn',
    notIn: 'in',
    like: 'notLike',
    notLike: 'like',
    isNull: 'isNotNull',
    isUndefined: 'isNotNull',
    isNotNull: 'isNull',
}

function negate(expr: BasicExpression<boolean>): BasicExpression<boolean> {
    if (expr.type !== 'func') {
        throw new Error(
            `Unsupported operand '${expr.type}' inside not() for PocketBase filter conversion`
        )
    }
    if (expr.name === 'not') {
        return pushDownNot(expr.args[0])
    }
    if (expr.name === 'and' || expr.name === 'or') {
        return new IR.Func(expr.name === 'and' ? 'or' : 'and', expr.args.map(negate))
    }
    const negated = NEGATED_OPERATORS[expr.name]
    if (!negated) {
        throw new Error(`Unsupported operator 'not(${expr.name})' for PocketBase filter conversion`)
    }
    return new IR.Func(negated, expr.args)
}

// PocketBase filters have no prefix `!`, so negations are pushed down onto comparison operators
function pushDownNot(expr: BasicExpression<boolean>): BasicExpression<boolean> {
    if (expr.type !== 'func') {
        return expr
    }
    if (expr.name === 'not') {
        return negate(expr.args[0])
    }
    if (expr.name === 'and' || expr.name === 'or') {
        return new IR.Func(expr.name, expr.args.map(pushDownNot))
    }
    return expr
}

export function convertToPocketBaseFilter(
    where: BasicExpression<boolean> | undefined | null
): string | undefined {
    if (!where) {
        return undefined
    }

    const result = parseWhereExpression(pushDownNot(where), {
        handlers: {
            eq: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} = ${escapeValue(value)}`
            },
            gt: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} > ${escapeValue(value)}`
            },
            gte: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} >= ${escapeValue(value)}`
            },
            lt: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} < ${escapeValue(value)}`
            },
            lte: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} <= ${escapeValue(value)}`
            },
            and: (...conditions: string[]) => {
                if (conditions.length === 0) return ''
                if (conditions.length === 1) return conditions[0]
                return `(${conditions.join(' && ')})`
            },
            or: (...conditions: string[]) => {
                if (conditions.length === 0) return ''
                if (conditions.length === 1) return conditions[0]
                return `(${conditions.join(' || ')})`
            },
            neq: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} != ${escapeValue(value)}`
            },
            in: (field: FieldPath, values: unknown) => {
                const valueArray = Array.isArray(values) ? values : [values]
                const uniqueValues = [...new Set(valueArray)]
                const fieldStr = fieldPathToString(field)
                const conditions = uniqueValues.map(v => `${fieldStr} = ${escapeValue(v)}`)
                return conditions.length > 1 ? `(${conditions.join(' || ')})` : conditions[0]
            },
            notIn: (field: FieldPath, values: unknown) => {
                const valueArray = Array.isArray(values) ? values : [values]
                const uniqueValues = [...new Set(valueArray)]
                const fieldStr = fieldPathToString(field)
                const conditions = uniqueValues.map(v => `${fieldStr} != ${escapeValue(v)}`)
                return conditions.length > 1 ? `(${conditions.join(' && ')})` : conditions[0]
            },
            notLike: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} !~ ${escapeValue(value)}`
            },
            like: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} ~ ${escapeValue(value)}`
            },
            isNull: (field: FieldPath) => {
                return `${fieldPathToString(field)} = null`
            },
            isUndefined: (field: FieldPath) => {
                return `${fieldPathToString(field)} = null`
            },
            isNotNull: (field: FieldPath) => {
                return `${fieldPathToString(field)} != null`
            },
        },
        onUnknownOperator: (operator: string, _args: unknown[]) => {
            throw new Error(
                `Unsupported operator '${operator}' for PocketBase filter conversion. ` +
                    `Supported operators: eq, gt, gte, lt, lte, in, like, and, or, not, isNull, isUndefined`
            )
        },
    })

    return result || undefined
}

export function convertToPocketBaseSort(
    orderBy: IR.OrderBy | undefined | null
): string | undefined {
    if (!orderBy) {
        return undefined
    }

    const sorts = parseOrderByExpression(orderBy)

    if (sorts.length === 0) {
        return undefined
    }

    return sorts
        .map((sort: ParsedOrderBy) => {
            const field = fieldPathToString(sort.field)
            return sort.direction === 'desc' ? `-${field}` : field
        })
        .join(',')
}
