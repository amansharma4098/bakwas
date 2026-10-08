# AI Studio — Down as a Service

A single-page parody status site with public anonymous reviews, deployed to **Cloudflare Workers + D1**.

- Site: https://bakwas.amansharma4098.workers.dev
- Worker: `bakwas`
- Cloudflare database: `bakwas-reviews` (`1dfb1a6a-3c48-4143-9411-4f789029f4e8`)
- Intended custom domain: `beakaistudio.com` (connect after importing the domain into Cloudflare)

The page lives in `index.html`; `worker.mjs` serves the shared review API. `scripts/build.mjs` copies only the public page and security headers into `dist/`. Source files and local databases are never published as static assets.

## Develop and test

Use Node.js 24 or newer.

```sh
npm ci
npm run db:local
npm run dev
```

For local Cloudflare development, create an ignored `.dev.vars` file containing a random `RATE_LIMIT_SECRET` value. Optional `MODERATION_TOKEN` enables administrative review deletion. Never commit real credentials.

`npm test` exercises both the Cloudflare Worker/D1 implementation and the original Node/SQLite server, including public visibility, deletion ownership, validation, pagination, and concurrent rate limits.

`npm start` still runs the original Node server at http://127.0.0.1:8000 with `.data/reviews.sqlite`. This is a separate local database; the deployed website stores reviews in **Cloudflare D1**, not on your Mac.

## Deploy

Authenticate with `npx wrangler login`, or provide `CLOUDFLARE_API_TOKEN` through your shell/CI secret store. Configuration in `wrangler.jsonc` targets this project's existing Worker and its dedicated D1 database.

```sh
npm run db:remote
npm run deploy
```

`RATE_LIMIT_SECRET` is already configured as a Cloudflare Worker secret. When setting up a separate deployment, create a strong random value using `npx wrangler secret put RATE_LIMIT_SECRET`. Secret values are not part of this repository or the public page.

Apply remote migrations before deploying API changes. Review data survives Worker deployments. The deployment commands do not upload `.data/reviews.sqlite` or visitors' old browser-only reviews.

## Reviews

- No name or email is requested. New reviews are public and contain 1–5 stars and 3–500 characters.
- The posting browser retains a private deletion key. Clearing browser data loses that key without removing the public review.
- Existing `stableware_reviews_v1` reviews stay private in their original browser and are never automatically uploaded.
- Sample roasts are labeled fictional. All visitor content is rendered as plain text.
- Cloudflare D1 atomically allows five posts per address per ten-minute window. Rate-limit records contain a rotating, secret-keyed hash; raw addresses are not saved in the application database. Expired records are cleaned up on later submissions. Cloudflare may separately process request metadata.
- The owner can delete a review from the posting browser. For moderation, configure `MODERATION_TOKEN` with `npx wrangler secret put MODERATION_TOKEN`, then send `DELETE /api/reviews/<id>` with JSON body `{}` and `Authorization: Bearer <MODERATION_TOKEN>`. The public API never returns deletion hashes or tokens.

## Connect the domain

After `beakaistudio.com` is imported into Cloudflare and its assigned nameservers are set at GoDaddy, add it as a Custom Domain on the `bakwas` Worker. Put the same mapping in `wrangler.jsonc` when connecting it so future deployments preserve it:

```json
"routes": [{ "pattern": "beakaistudio.com", "custom_domain": true }]
```

Keep domain registration at GoDaddy if desired; changing nameservers is enough. Review imported DNS records, including any existing mail records, before switching nameservers.

## Database management

In the Cloudflare dashboard, open **Storage & databases → D1 → bakwas-reviews** to inspect the database. To export a backup locally:

```sh
npx wrangler d1 export DB --remote --output /path/outside-the-repository/bakwas-reviews.sql
```

Local Node server options remain available: `HOST`, `PORT`, `DB_PATH`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, and `MODERATION_TOKEN`. They are not used by the Cloudflare Worker.
