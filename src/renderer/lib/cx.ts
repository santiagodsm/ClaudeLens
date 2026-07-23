/** Joins class names, dropping anything falsy. No dependency, no variants engine. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}
