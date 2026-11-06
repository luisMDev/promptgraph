/** Text of the signed-out page (DESIGN §14). */
export const SIGNED_OUT_TEXT = "promptgraph is running, but this browser is not signed in. Run `promptgraph open` in a terminal.";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>promptgraph: signed out</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e6e8eb; }
  main { max-width: 32rem; padding: 2rem; }
  code { background: #1c2026; padding: 0.1rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
<main>
<h1>Signed out</h1>
<p>promptgraph is running, but this browser is not signed in. Run <code>promptgraph open</code> in a terminal.</p>
</main>
</body>
</html>
`;

/**
 * The page an unauthenticated page request (or a /login with an invalid or expired code) gets: 401,
 * static HTML with inline styles only, no script, `Content-Security-Policy: default-src 'none';
 * style-src 'unsafe-inline'` and `Cache-Control: no-store` (DESIGN §14).
 */
export function signedOutPage(method = "GET"): Response {
  return new Response(method === "HEAD" ? null : HTML, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
