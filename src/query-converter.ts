import { IR, parseOrderByExpression, parseWhereExpression } from '@tanstack/db';

/**
 * Type alias for PocketBase filter strings
 */
export type PocketBaseFilterString = string;

/**
 * Type alias for PocketBase sort strings
 */
export type PocketBaseSortString = string;

/**
 * Formats a JavaScript value into PocketBase filter syntax
 * @param value - The value to format (string, number, boolean, Date, null)
 * @returns Formatted string suitable for PocketBase filters
 */
function formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
        // Escape double quotes in strings
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    if (value instanceof Date) {
        return `"${value.toISOString()}"`;
    }
    // Fallback: convert to string and quote
    return `"${String(value)}"`;
}

/**
 * Converts TanStack DB WhereExpression to PocketBase filter syntax
 *
 * Supports the following operators:
 * - eq: equality (=)
 * - gt: greater than (>)
 * - gte: greater than or equal (>=)
 * - lt: less than (<)
 * - lte: less than or equal (<=)
 * - in: membership (?= for arrays, or || chain)
 * - and: logical AND (&&)
 * - or: logical OR (||)
 *
 * Relation traversal is supported via dot notation (e.g., customer.address.city)
 *
 * @param where - TanStack DB where expression (AST)
 * @returns PocketBase filter string, or empty string if no filter
 * @throws Error if an unsupported operator is encountered
 */
export function convertToPocketBaseFilter(
    where: any,
): PocketBaseFilterString {
    if (!where) return '';

    const result = parseWhereExpression(where, {
        handlers: {
            eq: (field, value) => {
                const fieldPath = field.join('.');
                return `${fieldPath} = ${formatValue(value)}`;
            },
            gt: (field, value) => {
                const fieldPath = field.join('.');
                return `${fieldPath} > ${formatValue(value)}`;
            },
            gte: (field, value) => {
                const fieldPath = field.join('.');
                return `${fieldPath} >= ${formatValue(value)}`;
            },
            lt: (field, value) => {
                const fieldPath = field.join('.');
                return `${fieldPath} < ${formatValue(value)}`;
            },
            lte: (field, value) => {
                const fieldPath = field.join('.');
                return `${fieldPath} <= ${formatValue(value)}`;
            },
            in: (field, values) => {
                const fieldPath = field.join('.');

                // Handle array of values - create OR chain with ?= operator for each value
                if (Array.isArray(values)) {
                    if (values.length === 0) {
                        // Empty array - no matches possible
                        return 'id = ""'; // Always false condition
                    }
                    // Use ?= operator for "any equals" semantics
                    const conditions = values.map(v => `${fieldPath} ?= ${formatValue(v)}`);
                    return conditions.length === 1
                        ? conditions[0]
                        : `(${conditions.join(' || ')})`;
                }

                // Single value - just use equality
                return `${fieldPath} = ${formatValue(values)}`;
            },
            and: (...conditions) => {
                // Filter out any empty conditions
                const nonEmpty = conditions.filter(c => c && c.trim() !== '');
                if (nonEmpty.length === 0) return '';
                if (nonEmpty.length === 1) return nonEmpty[0];
                return `(${nonEmpty.join(' && ')})`;
            },
            or: (...conditions) => {
                // Filter out any empty conditions
                const nonEmpty = conditions.filter(c => c && c.trim() !== '');
                if (nonEmpty.length === 0) return '';
                if (nonEmpty.length === 1) return nonEmpty[0];
                return `(${nonEmpty.join(' || ')})`;
            },
        },
        onUnknownOperator: (op) => {
            throw new Error(
                `Unsupported query operator for PocketBase: "${op}". ` +
                `Supported operators: eq, gt, gte, lt, lte, in, and, or`,
            );
        },
    });

    return result;
}

/**
 * Converts TanStack DB OrderByExpression to PocketBase sort syntax
 *
 * Supports:
 * - Single or multiple sort fields
 * - Ascending (asc) and descending (desc) directions
 * - Relation traversal via dot notation
 *
 * PocketBase sort format: comma-separated fields with '-' prefix for DESC
 * Example: "-created,name" sorts by created DESC, then name ASC
 *
 * @param orderBy - TanStack DB order by expression
 * @returns PocketBase sort string, or empty string if no sorting
 */
export function convertToPocketBaseSort(
    orderBy: any,
): PocketBaseSortString {
    if (!orderBy) return '';

    const sorts = parseOrderByExpression(orderBy);

    return sorts
        .map((sort) => {
            const fieldPath = sort.field.join('.');
            const prefix = sort.direction === 'desc' ? '-' : '';
            return `${prefix}${fieldPath}`;
        })
        .join(',');
}
