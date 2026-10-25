/** Strict wire syntax; unused pad bits intentionally retain atob's permissive behavior. */
export function isValidBase64(data: string, bytes: number): boolean {
  if (data.length !== 4 * Math.ceil(bytes / 3)) return false;
  const padding = (3 - bytes % 3) % 3;
  const end = data.length - padding;
  for (let index = 0; index < end; index++) {
    const code = data.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  for (let index = end; index < data.length; index++) if (data.charCodeAt(index) !== 61) return false;
  return true;
}
