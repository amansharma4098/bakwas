# AI Studio — Down as a Service

A compact parody status page with public anonymous reviews. All visual assets, styles, and client code live in `index.html`. A dependency-free Node server stores shared reviews in SQLite.

## Run

Use Node.js 24 or newer. No package installation or build step is needed.

```sh
npm start
```

Open http://127.0.0.1:8000. Run `npm test` for API, persistence, privacy, validation, and rate-limit checks. Opening the HTML directly previews the design, but public reviews require the server.

## Behavior

- “Try your luck” delivers different excuses and a three-second simulated recovery every seventh attempt.
- Visitors can post 1–5 stars and 3–500 characters without providing a name or email. Reviews appear publicly, newest first, with pagination.
- A private deletion key stays in the posting browser. Its owner can remove the review there. Clearing browser data loses this key, but does not delete a public review.
- The existing `stableware_reviews_v1` browser-only reviews remain private and are never uploaded automatically.
- Sample roasts are explicitly fictional and separate from visitor reviews. The page identifies itself as an unofficial parody.
- Review text is rendered as plain text. Each address can submit five reviews per ten minutes. The application does not save IP addresses with reviews; hosting providers may keep their own access logs.

## Hosting

Run the Node server on a host with a **persistent disk**. Static hosting alone cannot run the public review API. The default database is `.data/reviews.sqlite`; keep this directory across deployments and back it up. Run one application instance against this database.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Listening port; defaults to `8000`. |
| `HOST` | Defaults to `127.0.0.1`; set to `0.0.0.0` when your hosting platform requires it. |
| `DB_PATH` | Absolute SQLite file path on persistent storage. |
| `PUBLIC_ORIGIN` | Public site origin, such as `https://your-domain.example`; set this behind an HTTPS reverse proxy. |
| `TRUST_PROXY` | Set to `1` only behind a trusted reverse proxy that supplies or appends the real client address in `X-Forwarded-For` and prevents direct external access to the app. Otherwise leave unset. |
| `MODERATION_TOKEN` | Optional strong, private admin token for removing public reviews. Never put it in HTML or client code. |

To moderate, send `DELETE /api/reviews/<id>` with `Content-Type: application/json`, an empty JSON object as the body, and `Authorization: Bearer <MODERATION_TOKEN>`. A visitor uses their own deletion key instead. The public listing never exposes deletion keys or their hashes.

No hosting or domain settings are changed by this project.
