# Forge: candidate repositories

Projects whose published policy **allows AI-assisted contributions**, from the community list
[melissawm/open-source-ai-contribution-policies](https://github.com/melissawm/open-source-ai-contribution-policies)
(read 25 November 2026). That list warns its classification is only a guide, so **open the project's own policy
and re-check it on the day before any pull request**: policies change, and several projects have tightened them.

Every pull request follows the rules in this folder's README: a person reads and understands the whole diff first,
the AI assistance is disclosed exactly as the project asks (PR text, `Assisted-by:` or `Generated-by:` trailers),
one open PR per project at a time, nothing in bulk, and the account says clearly that it is AI-assisted.

## Allowed with disclosure and a human in the loop (good first targets)

| Project | What the policy asks | Notes |
| --- | --- | --- |
| Apache Airflow | Disclose, human in the loop, copyright statement | Watches for "AI-slop" PRs; small, tested fixes only |
| Apache Arrow | Disclose, human in the loop | Large codebase; pick labelled good-first issues |
| Apache Kvrocks | Disclose, human in the loop | Smaller C++ project |
| Apache projects generally | `Generated-by:` trailer in commits (ASF guidance) | Enforcement differs per project |
| Cilium | Disclose, human in the loop, DCO sign-off on every commit | Go |
| CloudNativePG | Disclose, human in the loop | Go |
| Django | Disclose in the PR template; no automated AI reviews | Python, very high review bar |
| Drupal | Disclose, human in the loop | PHP |
| EasyBuild | Disclose the specific AI tools/models used | Name "Stellan Lite/Max" exactly |
| Fedify | `Assisted-by:` trailer, never `Co-authored-by` for AI | TypeScript |
| GDAL | Disclose, human in the loop | C++ |
| Gitea | Disclose, human in the loop | Go |
| CCExtractor | Mark PRs "AI-generated / AI-assisted / No AI used" | C |

## Allowed, disclosure optional or lighter (be careful)

Apache DataFusion, Astropy, conda, CPython ("disclosure appreciated"), CuPy, Firefox, Flutter, FastAPI
("don't submit if your effort is less than our review effort"), attrs ("no LLM bots in Co-authored-by").
Disclose anyway.

## Do not target

Projects that ban or effectively ban AI contributions, including (from the same list) Alacritty, Bevy,
Clojure, Elastic, Gentoo, GIMP, Forgejo, Immich, and any project whose policy says autonomous agent submissions are
not accepted (for example dlt). Ghostty and curl allow AI use but set a very high bar; skip them until Forge has a
track record.

## Realistic expectations

These are serious projects with busy maintainers. Expect most attempts by a 7B/24B model to need real human work, and
some maintainers to close AI-assisted PRs even where the policy allows them. Count a pull request as Forge data only
after a person has reviewed it, and record the outcome (merged, changes requested, closed) honestly.
