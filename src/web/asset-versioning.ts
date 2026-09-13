/**
 * The one HTML asset-reference rewriter, shared by every page this server
 * hands out: the authenticated app, the login/setup shells, and the public
 * share page.
 *
 * It rewrites local .js and .css references onto a versioned
 * `/v/<buildVersion>/...` PATH prefix.
 *
 * Why a path prefix and not a query string (`?v=...`) — two reasons, and
 * both of them have cost us a production outage:
 *
 *  1. Some upstream caches ignore the query string when computing a cache
 *     key. Cloudflare is the one that bit us: the same `/lib/ui.js` kept
 *     being served stale no matter what `?v=` the HTML asked for.
 *
 *  2. ES module relative imports inherit a path prefix automatically and
 *     CANNOT inherit a query string. Loaded from `/v/abc/app.js`, an
 *     `import './lib/ui.js'` resolves to `/v/abc/lib/ui.js` — versioned for
 *     free. Loaded from `/app.js?v=abc`, the very same import resolves to a
 *     bare `/lib/ui.js`, because a query string is not part of the base URL
 *     a relative specifier resolves against. So the query form versions the
 *     entry point and nothing else, which is the half that matters least:
 *     the entry point is one file, and its imports are the rest of the app.
 *
 * That second point is not theoretical. The public share page carried its
 * own copy of this function that had drifted to the `?v=` form, so every
 * `lib/*.js` it pulled in was fetched at a bare, unversioned URL. When
 * `lib/mobile-rows.js` was briefly missing from the unauthenticated asset
 * allowlist, Cloudflare cached the resulting `302 -> /login` against that
 * bare URL and kept serving it for eighteen hours — the share links stayed
 * blank for most of a day after the allowlist fix had shipped and deployed.
 * A versioned URL would have made the deploy itself the cure, because the
 * new build asks for a URL no cache has ever seen.
 *
 * Hence: one rewriter, one form, imported by both callers. Two copies of
 * this that disagree is the bug, not the code duplication.
 *
 * Matching only `[\w./-]` (which excludes `:`) keeps absolute URLs out — an
 * earlier regex here matched anything up to `.js` and happily turned the
 * Chart.js CDN tag into `/v/<hash>/https://...`. The leading `/` is consumed
 * outside the capture group so `/app.js` becomes `/v/<hash>/app.js` rather
 * than `/v/<hash>//app.js`.
 */
export function versionHtmlAssets(html: string, buildVersion: string): string {
  return html
    .replace(/(href=")\/?([\w./-]+\.css)(")/g, `$1/v/${buildVersion}/$2$3`)
    .replace(/(src=")\/?([\w./-]+\.js)(")/g, `$1/v/${buildVersion}/$2$3`);
}
