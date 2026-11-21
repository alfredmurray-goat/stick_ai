# One-time activation

Sold sticks ask for the code printed in the box the first time they start. It needs the internet once, for a few seconds; after that the stick works offline forever.

## How it works

1. The app reads the stick's **USB serial number** (the same on Mac, Windows and Linux) and turns it into a fingerprint (SHA-256). If a computer can't read the serial, it uses the volume ID instead.
2. It sends the code and the fingerprint to `https://stick-ai.localilabs.com/api/activate`.
3. The website ties the code to that stick and returns a **certificate signed with Ed25519**. Each code has 3 "seats", so one stick that looks slightly different to different computers still works; a 4th different stick is refused.
4. The certificate is saved in `stellan/logs/activation.json` on the stick and checked **offline** at every start against the public key built into the app (`activationPublicKey` in `src/portable/activation.ts`).

Activation works even when **Allow internet** is turned off in Settings: typing the printed code is the one time the app goes online on purpose.

Copying the stick's files to another stick doesn't carry the activation: the other stick has a different serial. This stops casual sharing; it can't stop a determined expert, because the app is open source. Builds without a public key (development, tests) never ask.

## Setting it up (owner, once)

1. In Vercel → the website project → **Settings → Environment Variables**, add **`ACTIVATION_ADMIN_TOKEN`**: a long password only you know (at least 20 characters; a password manager can make one). Redeploy.
2. Open **stick-ai.localilabs.com/admin**, enter that password under **Set up**, and click **Set up activation**. It creates the signing key (kept in your Upstash database, never shown) and shows the **public key**.
3. Put the public key into `activationPublicKey` in `src/portable/activation.ts` and ship a new release. From then on, sticks made from that release ask for a code.

The database is the same Upstash store the sign-up form uses.

## Everyday use (owner)

- **Make codes:** on `/admin`, under **Make codes to print**, choose how many and click **Make codes**. Print one per box, for example in the code box on the quick-start leaflet (`docs/packaging/quick-start-guide.pdf`).
- **Help a customer:** **Look up** shows whether a code is used and when. **Reset** frees it so it can activate a replacement stick.
