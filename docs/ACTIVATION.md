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

## Locked models

Activation also unlocks the models. A sold stick carries each model as two files in `stellan/models`:

- `<model>.locked`: the first part (about 80 MB: the settings, vocabulary and many small but vital pieces of the weights), encrypted with AES-256-GCM.
- `<model>-00002-of-00002.gguf`: the rest, in the clear but useless without the first part.

The keys are made once on the website (`/admin` → **Set up activation** creates them) and handed to each stick when it activates, sealed with a key derived from that stick's fingerprint and code. At every start the app decrypts the first part into the computer's temporary folder (about 0.3 seconds, ~80 MB), and llama.cpp reads the rest straight from the stick. It's our llama.cpp build with one small patch (`scripts/llama-split-dir.patch`) that lets it find the rest in another folder. Answers and speed are exactly the same as with the plain file (checked word for word).

The split is the same every time, so its hashes are pinned in `src/portable/locked-models.ts`, and the app checks them like every other file. A stick can still carry plain models (for development or your own use); then no key is needed.

### Locking models for selling (owner)

1. Do the one-time setup above first.
2. Put the plain models in `stellan/models` on one stick, as before, then open the install helper again. It finds the plain models and asks whether to lock them. Type `y`, then the activation desk password (the `ACTIVATION_ADMIN_TOKEN`). It needs the internet and takes a few minutes, mostly for Max.
3. The helper checks the locked files against the pinned hashes, then deletes the plain ones. Copy `stellan/models` from that stick to your other sticks: the locked files are the same for every stick.

Keep your plain models somewhere safe and private (and set the Hugging Face repositories to private). Locking stops copied files from running elsewhere. It can't stop a determined expert who has an activated stick, because the app is open source.
