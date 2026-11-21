# Opening Stick AI the first time

Stick AI isn't signed with a paid Apple Developer ID or a Windows code-signing certificate, so a computer may ask once before opening it. The steps below go on the stick (`Read me.txt`), on the box card and on the website's help page.

## Will customers see a warning at all?

Usually not, when they run the apps straight from the stick:

- **macOS** blocks unsigned apps that carry the "quarantine" mark, which browsers add to downloads. The install helpers copy the apps onto the stick with `ditto --noqtn`, and exFAT can't keep the mark anyway, so apps opened from a sold stick normally start without a prompt. The Mac app is ad-hoc signed, which Apple Silicon requires.
- **Windows** SmartScreen checks files that carry the Mark of the Web, which is stored in an NTFS alternate data stream. exFAT has no alternate data streams, so files on the stick can't carry it.
- **Smart App Control** (Windows 11, on some fresh installs) blocks unsigned apps whatever their origin. There's no "run anyway" for it; it has to be turned off in Windows Security → App & browser control. Only signing the app avoids this.

Copies a customer downloads or copies to an internal disk may still be flagged.

## The steps

**Mac (macOS 15 Sequoia and later).** Right-click → Open no longer bypasses the check. If macOS says Stick AI "can't be opened" or "Apple could not verify" it:

1. Click **Done** (not Move to Bin).
2. Open **System Settings → Privacy & Security**.
3. Scroll to **Security** and click **Open Anyway** next to Stick AI.
4. Open Stick AI again, click **Open Anyway** and enter the account password.

([Apple: open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac))

**Windows.** On "Windows protected your PC", click **More info**, then **Run anyway**.

**Linux.** If `stick-ai` won't start, mark it as executable: right-click → Properties → Permissions → **Allow executing file as program** (or `chmod +x stick-ai`).

## Box card

[`docs/packaging/first-open-card.html`](packaging/first-open-card.html) is a printable A6 card (105 × 148 mm): getting started on the front, the steps above on the back. [`first-open-card.pdf`](packaging/first-open-card.pdf) is the same card ready to print double-sided (flip on the long edge) at 100% scale. The fonts beside it are Space Grotesk and JetBrains Mono under the SIL Open Font License.

[`docs/packaging/quick-start-guide.html`](packaging/quick-start-guide.html) is a fuller A5 leaflet (148 × 210 mm) for the box: five start steps, a box for the **activation code** (leave it blank for a printed sticker or write the code in), what the stick needs, everyday use, the first-open steps and help. [`quick-start-guide.pdf`](packaging/quick-start-guide.pdf) is ready to print double-sided at 100% scale. The activation step describes one-time activation, which ships in the next app release.
