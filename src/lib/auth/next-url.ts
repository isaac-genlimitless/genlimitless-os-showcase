// Shared by the sign-in page (client) and its tests. No imports.
/** Where to go after signing in. nginx sends the raw path + query ("?next=/a?b=1&c=2"), the app sends it
 *  encoded ("?next=%2Fa%3Fb%3D1"), so take everything after the first "next=" and decode only if encoded. */
export function safeNext(search: string): string {
  const i = search.indexOf("next=");
  if (i < 0) return "/";
  let n = search.slice(i + 5);
  if (/^%2f/i.test(n)) {
    try {
      n = decodeURIComponent(n);
    } catch {
      return "/";
    }
  }
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && !n.startsWith("/login") ? n : "/";
}
