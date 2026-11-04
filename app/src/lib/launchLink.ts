/**
 * The in-app address a notification asked for, from the link that started the app (a chat, or an inbox card),
 * or null for any other start. These are the only two addresses a notification carries.
 */
export function launchPath(url: string | null | undefined): string | null {
  const m = typeof url === 'string' ? url.match(/^winglet(?:-dev)?:\/\/((?:chat\/|inbox\?).+)$/) : null;
  return m ? `/${m[1]}` : null;
}
