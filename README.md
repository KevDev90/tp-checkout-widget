# Trustpilot Checkout Widget

Shopify checkout UI extension that shows Trustpilot ratings and reviews on the **checkout** page. Merchants can choose a summary, list, or carousel layout. Trustpilot API calls run on a backend proxy so the API key never reaches the browser.

## High-level overview

```
Buyer checkout
    │
    ▼
Shopify Checkout UI Extension  (extensions/trustpilot-checkout-block)
    │  fetch JSON + load brand assets
    ▼
Cloudflare Worker proxy  (cf-worker/)  ← TRUSTPILOT_API_KEY lives here
    │  cached GETs (~15 min)
    ▼
Trustpilot Public API  (business unit + reviews)
```

| Piece | Role |
|--------|------|
| **Checkout extension** | React UI on `purchase.checkout.block.render`. Reads merchant settings (BUID, domain, layout, filters). Caches review JSON in checkout session storage. |
| **Cloudflare Worker** | Server-side proxy: holds the API key, calls Trustpilot, caches responses, serves brandmark / star-strip images. |
| **Shopify app proxy** | Shop URLs like `/apps/tp-proxy/img/tp/...` forward to the worker so checkout `Image` can load assets reliably. |
| **Express (`server.js`)** | Optional local / alternate proxy (same routes). Production path is the Worker. |

**What merchants configure in the checkout editor**

- Trustpilot Business Unit ID (BUID)
- Trustpilot domain (for profile links)
- Layout: review summary / review list / review carousel
- Reviews to show: 2–10 (list & carousel)
- Which reviews: 5-star only, 4 & 5 star, or latest

## Prerequisites

1. [Node.js](https://nodejs.org/) (18+ recommended)
2. [Shopify Partner account](https://partners.shopify.com/signup) and a development or Plus sandbox store
3. [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (installed via this repo’s dependencies)
4. [Cloudflare account](https://dash.cloudflare.com/) + [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler` works)
5. Trustpilot API access (Enterprise, or Premium + API Module) and a **Business Unit ID**
6. A Trustpilot API key (never commit it)

### Finding your BUID

```text
GET https://api.trustpilot.com/v1/business-units/find?apikey=YOUR_KEY&name=yourdomain.com
```

Use the `id` field from the response as **Trustpilot Business Unit ID** in the extension settings.

## Project structure

```text
tp-checkout-widget/
├── extensions/trustpilot-checkout-block/   # Checkout UI extension
│   └── src/Checkout.jsx
├── cf-worker/                              # Cloudflare Worker proxy (recommended)
│   ├── src/index.js
│   └── wrangler.toml
├── server.js                               # Optional Express proxy
├── shopify.app*.toml                       # Shopify app + app proxy config
├── .env.example                            # Template for local Express only
└── package.json
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/KevDev90/tp-checkout-widget.git
cd tp-checkout-widget
npm install
```

### 2. Link the Shopify app

```bash
npx shopify auth login
npx shopify app config link
```

This repo includes multiple app configs (`shopify.app.toml`, `shopify.app.tp-demo-clean.toml`, `shopify.app.tp-checkout-clean.toml`). Pick the one that matches the Partner app you want to use:

```bash
npx shopify app config use
```

### 3. Deploy the Cloudflare Worker proxy

```bash
npx wrangler login
npx wrangler secret put TRUSTPILOT_API_KEY --config cf-worker/wrangler.toml
# paste your Trustpilot API key when prompted

npm run worker:deploy
```

Note the Worker URL, e.g. `https://tp-checkout-proxy.<your-subdomain>.workers.dev`.

### 4. Point the app and extension at your Worker

1. Set `[app_proxy].url` in your active `shopify.app*.toml` to the Worker URL:

```toml
[app_proxy]
url = "https://tp-checkout-proxy.YOUR_SUBDOMAIN.workers.dev"
subpath = "tp-proxy"
prefix = "apps"
```

2. Set the same host in the extension as `PROXY_BASE_URL` in:

`extensions/trustpilot-checkout-block/src/Checkout.jsx`

API calls go to the Worker; images prefer the shop app-proxy path and fall back to the Worker.

### 5. Local development

```bash
npm run dev
```

This runs `shopify app dev`, links a preview URL, and lets you install/update the app on a development store.

Optional Worker-only remote preview:

```bash
npm run worker:dev
```

Optional Express proxy (local only):

```bash
cp .env.example .env
# put TRUSTPILOT_API_KEY in .env
npm run server
```

Do **not** commit `.env`.

### 6. Add the block in checkout

1. Open the store’s **Checkout editor** (Shopify Admin → Settings → Checkout → Customize).
2. Add the **Trustpilot Reviews** app block.
3. Fill in BUID, domain, layout, and review options.
4. Save and place an order (or use checkout preview) to verify.

## Deploy / update production

| What changed | Command |
|--------------|---------|
| Checkout extension or app config | `npm run deploy` (`shopify app deploy`) |
| Proxy API / image routes | `npm run worker:deploy` |
| Both | Worker first, then `shopify app deploy` |

After deploy, hard-refresh checkout (or use a private window) so you’re not on a cached extension bundle.

Sanity-check app proxy images on the store:

```text
https://YOUR-STORE.myshopify.com/apps/tp-proxy/img/tp/brandmark
```

That should return a PNG (not HTML). If it 404s, the app isn’t installed or app proxy isn’t configured for that store.

## Merchant settings reference

| Setting | Values | Notes |
|---------|--------|--------|
| Trustpilot Business Unit ID | string | Required |
| Trustpilot Domain | e.g. `example.com` | Profile link fallback |
| Widget layout | `summary` / `list` / `carousel` | Summary = rating header only |
| Reviews to show | 2–10 | List & carousel only |
| Which reviews to show | `five_only` / `four_and_five` / `latest` | List & carousel; UI discloses the filter |

## Security notes

- **API key** stays on the Worker (`wrangler secret`) or in local `.env` for Express. Never put it in the extension.
- **BUID** is a public Trustpilot identifier. It appears in network requests to your proxy; that is expected and low risk without the API key.
- Domain is used for public profile links on a store the buyer is already visiting.
- Use `.env.example` / `cf-worker/.dev.vars.example` as templates only. Real secrets stay gitignored.

## Caching behavior

| Layer | Behavior |
|--------|----------|
| Worker JSON | Cloudflare cache, ~15 minutes (`max-age=900`) |
| Extension | Shopify `useStorage()` so revisiting checkout steps doesn’t re-hit the Worker every time |
| Images | Edge / proxy caching for brandmark and star strips |

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Shopify app + extension local preview |
| `npm run deploy` | Publish extension / app config to Shopify |
| `npm run worker:dev` | Wrangler remote Worker preview |
| `npm run worker:deploy` | Deploy Worker to Cloudflare |
| `npm run server` | Run optional Express proxy |
| `npm run config:link` | Link CLI to a Partner app |

## Requirements / scope

- Built for **Shopify checkout** (`purchase.checkout.block.render`), not the thank-you page.
- Trustpilot custom API / TrustBox guidelines: server-side calls, caching, and disclosing filtered reviews are supported by this architecture.
- Requires a Shopify store that can use **checkout UI extensions** (typically Shopify Plus / eligible plans for checkout extensibility).

## License

Private / use as allowed by your organization unless a `LICENSE` file is added to this repository.
