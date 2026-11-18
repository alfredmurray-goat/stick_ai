# Stick AI website

The landing page for Stick AI. Plain HTML and CSS: no build step, no JavaScript, no third-party requests.

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import `alfredmurray-goat/stick_ai`.
2. Set **Framework Preset** to **Other**. Leave the build and output settings empty.
3. Under **Settings → Git**, set the **Production Branch** to `website`.
4. Under **Settings → Domains**, add `stick-ai.localilabs.com` (a hyphen, not an underscore: hostnames with underscores can't get an HTTPS certificate) and add the DNS record Vercel shows at your domain provider.

## Editing

- Prices: search `index.html` for `PRICE:`.
- Launch dates: search for `February 2027` and `May 2027`.
- Screenshots live in `img/` (WebP plus a JPEG fallback), made from the app repo's `docs/` images.
