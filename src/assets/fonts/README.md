# Fonts for OG card rendering

These TTFs exist **only** so `satori` can rasterise the Open Graph cards at build
time. The browser never downloads them — the site loads Bricolage Grotesque as a
subsetted woff2 through `@fontsource-variable/bricolage-grotesque`.

## Why a second copy of the same typeface

satori parses fonts with a fork of `opentype.js`, and it accepts neither format
the site already has:

- **woff2** is rejected outright: `Unsupported OpenType signature wOF2`. It is
  not a variable-font problem, the parser has no woff2 decompressor at all.
- **the variable TTF** (from `google/fonts`) parses far enough to crash on the
  `fvar` table: `Cannot read properties of undefined (reading '256')` while
  resolving axis names.

Static TTF instances are the only thing that works, so they are vendored here.

## Provenance

Downloaded from the upstream project, `ateliertriay/bricolage`, at
`fonts/ttf/BricolageGrotesque-{Regular,SemiBold}.ttf`.

Licensed under the SIL Open Font License 1.1 — see `OFL.txt`, copied from the
same source. The OFL requires the licence to travel with the font files, which
is why it sits next to them rather than being folded into the project licence.

## The alternative, and why it was rejected

Reading a system font instead (DejaVu on CI, Arial on macOS) means the cards
render in a different typeface from the site, and in a _different_ typeface
depending on which machine built them. Vendoring 230 KB that never reaches a
browser is the cheaper trade.
