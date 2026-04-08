export function jsonResult(obj: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}
