# `project-names` — §3.3/§3.5 as amended 2026-07-22

Tiny, synthetic, hand-written. Six project directories that cover the whole display-name rule.
The **shape** of every folder name here is the shape of the real bug: **every one contains a
hyphen**, because a folder whose name has no hyphen is named identically by the old decode-the-
encoded-name rule and by the new derive-from-`cwd` rule, and would prove nothing.

Paths are invented (`/work/demo/…`). Nothing personal ships (P-33, §7.8).

| directory (`encoded_name`) | `cwd` in its records | expected name | why it is here |
|---|---|---|---|
| `-work-demo-Photo-Booth` | `/work/demo/Photo-Booth` | `Photo-Booth` | the reported bug — used to read "Booth" |
| `-work-demo-Home-Media-Server` | `/work/demo/Home-Media-Server` | `Home-Media-Server` | two hyphens — used to read "Server" |
| `-work-demo-Portfolio-Site` | `/work/demo/Portfolio-Site/website` | `Portfolio-Site` | the `cwd` is a SUBDIRECTORY; the basename of the raw `cwd` would be "website" |
| `-work-other-Photo-Booth` | `/work/other/Photo-Booth` | `Photo-Booth` | a second, unrelated project that legitimately shares the name — still two rows, two identities |
| `-work-demo-No-Cwd` | *(none — the field is absent)* | `Cwd` | the fallback: today's decoded-`encoded_name` behaviour, never unnamed |
| `-work-demo-Split-Root` | 2 × `/work/demo/Split.Root`, 1 × `/work/demo/Split-Root` | `Split.Root` | events disagree; the most frequent root wins |
