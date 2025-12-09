import { parseWhereExpression, parseOrderByExpression, type FieldPath, type ParsedOrderBy } from '@tanstack/db';
import type { IR } from '@tanstack/db';

type BasicExpression<T = unknown> = IR.BasicExpression<T>;

function escapeValue(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
        return value.toString();
    }
    if (typeof value === 'string') {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    if (value instanceof Date) {
        return `"${value.toISOString()}"`;
    }
    if (Array.isArray(value)) {
        return `[${value.map(escapeValue).join(',')}]`;
    }
    return `"${String(value)}"`;
}

function fieldPathToString(path: FieldPath): string {
    return path.join('.');
}

export function convertToPocketBaseFilter(
    where: BasicExpression<boolean> | undefined | null
): string | undefined {
    if (!where) {
        return undefined;
    }

    const result = parseWhereExpression(where, {
        handlers: {
            eq: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} = ${escapeValue(value)}`;
            },
            gt: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} > ${escapeValue(value)}`;
            },
            gte: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} >= ${escapeValue(value)}`;
            },
            lt: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} < ${escapeValue(value)}`;
            },
            lte: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} <= ${escapeValue(value)}`;
            },
            and: (...conditions: string[]) => {
                if (conditions.length === 0) return '';
                if (conditions.length === 1) return conditions[0];
                return `(${conditions.join(' && ')})`;
            },
            or: (...conditions: string[]) => {
                if (conditions.length === 0) return '';
                if (conditions.length === 1) return conditions[0];
                return `(${conditions.join(' || ')})`;
            },
            not: (condition: string) => {
                return `!(${condition})`;
            },
            in: (field: FieldPath, values: unknown) => {
                const valueArray = Array.isArray(values) ? values : [values];
                const uniqueValues = [...new Set(valueArray)];
                const fieldStr = fieldPathToString(field);
                const conditions = uniqueValues.map((v) => `${fieldStr} = ${escapeValue(v)}`);
                return conditions.length > 1 ? `(${conditions.join(' || ')})` : conditions[0];
            },
            like: (field: FieldPath, value: unknown) => {
                return `${fieldPathToString(field)} ~ ${escapeValue(value)}`;
            },
            isNull: (field: FieldPath) => {
                return `${fieldPathToString(field)} = null`;
            },
            isUndefined: (field: FieldPath) => {
                return `${fieldPathToString(field)} = null`;
            },
        },
        onUnknownOperator: (operator: string, args: unknown[]) => {
            throw new Error(
                `Unsupported operator '${operator}' for PocketBase filter conversion. ` +
                    `Supported operators: eq, gt, gte, lt, lte, in, like, and, or, not, isNull, isUndefined`
            );
        },
    });

    return result || undefined;
}

export function convertToPocketBaseSort(
    orderBy: IR.OrderBy | undefined | null
): string | undefined {
    if (!orderBy) {
        return undefined;
    }

    const sorts = parseOrderByExpression(orderBy);

    if (sorts.length === 0) {
        return undefined;
    }

    return sorts
        .map((sort: ParsedOrderBy) => {
            const field = fieldPathToString(sort.field);
            return sort.direction === 'desc' ? `-${field}` : field;
        })
        .join(',');
}
