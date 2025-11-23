/**
 * Generates a new PocketBase-compatible record ID.
 * Returns a 15-character alphanumeric string (lowercase letters and numbers).
 *
 * PocketBase uses 15-character IDs for records, formatted as lowercase alphanumeric.
 *
 * @returns A 15-character alphanumeric string suitable for use as a PocketBase record ID
 *
 * @example
 * ```ts
 * const id = newRecordId(); // "a1b2c3d4e5f6g7h"
 * ```
 */
export function newRecordId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 15; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
