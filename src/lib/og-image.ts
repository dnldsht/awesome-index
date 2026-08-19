/**
 * Build-time OG cards: satori lays the card out as SVG, resvg rasterises it.
 *
 * Imported only by the two endpoints under `src/pages/og*`, never by a page;
 * see `og.ts` for the paths.
 */

import { Resvg } from "@resvg/resvg-js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import satori from "satori";
import { liveness, type Liveness } from "./format.ts";
import { OG_HEIGHT, OG_WIDTH } from "./og.ts";

/* -------------------------------------------------------------------------- */
/* fonts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * satori parses fonts with a fork of opentype.js that accepts neither format
 * the site already ships: woff2 is rejected outright ("Unsupported OpenType
 * signature wOF2", since it has no decompressor), and the variable TTF crashes it
 * while reading `fvar` axis names. Static TTF instances of the brand face are
 * vendored under `src/assets/fonts` for exactly this reason; see the README
 * there for provenance and licence.
 *
 * Reading a host font instead would set the cards in DejaVu on CI and Arial on
 * a Mac: a different typeface from the site, and a different one per machine.
 */
// resolved from the working directory, not from import.meta.url: this module is
// bundled into dist/.prerender before it runs, and the fonts do not follow it
// there. config.yaml and data/awesome.db are already read the same way.
const FONT_DIR = path.resolve(process.cwd(), "src/assets/fonts");

type SatoriFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

let fontsPromise: Promise<SatoriFont[]> | undefined;

/** read once per build, not once per card */
function fonts(): Promise<SatoriFont[]> {
  fontsPromise ??= (async () => {
    const [regular, semibold] = await Promise.all([
      fs.readFile(path.join(FONT_DIR, "BricolageGrotesque-Regular.ttf")),
      fs.readFile(path.join(FONT_DIR, "BricolageGrotesque-SemiBold.ttf")),
    ]);
    return [
      { name: "OG", data: regular, weight: 400, style: "normal" },
      // the family's heaviest vendored instance stands in for bold: the cards
      // ask for 700 and SemiBold is what carries the display voice on the site
      { name: "OG", data: semibold, weight: 700, style: "normal" },
    ];
  })();
  return fontsPromise;
}

/* -------------------------------------------------------------------------- */
/* the card                                                                   */
/* -------------------------------------------------------------------------- */

/** src/styles/global.css, duplicated because satori cannot read a stylesheet */
const INK = "#191d28";
const INK_SOFT = "#4c5462";
const MUTE = "#7b818d";
const PAPER = "#ffffff";
const RULE = "#e2e6ec";
const ACCENT = "#4a3dd0";

const PULSE: Record<Liveness, string> = {
  active: "#0e7c6b",
  steady: "#4a3dd0",
  slowing: "#9a6b18",
  dormant: "#9aa1ad",
};

/**
 * satori accepts React elements; we hand it the plain `{ type, props }` shape
 * they compile down to. No JSX pragma to juggle, and no preact vnode with its
 * extra fields being passed off as a React one.
 */
type Node = {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown };
};

const box = (
  style: Record<string, unknown>,
  children?: Node[] | string,
): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children },
});

export type OgCard = {
  /** small line above the headline, set in caps */
  eyebrow: string;
  headline: string;
  /** one line of figures under the headline */
  detail: string;
  /**
   * Colours the left stripe. The stripe is the site's signature (every entry
   * carries its pulse in the left margin) so the card says "still moving" or
   * "gone quiet" before a word of it is read. Undefined for the default card,
   * which is about no single thing.
   */
  pulse?: Liveness;
};

function card(input: OgCard): Node {
  const stripe = input.pulse ? PULSE[input.pulse] : ACCENT;

  return box(
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      background: PAPER,
      fontFamily: "OG",
      color: INK,
    },
    [
      box({ width: 18, height: "100%", background: stripe }),
      box(
        {
          flex: "1",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "68px 72px",
        },
        [
          box(
            {
              fontSize: 24,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: MUTE,
            },
            input.eyebrow,
          ),
          box({ flexDirection: "column" }, [
            box(
              {
                fontSize: 84,
                fontWeight: 700,
                letterSpacing: -2,
                lineHeight: 1.05,
                // satori has no `text-wrap`, so long list names are simply
                // allowed to run onto a second line inside a fixed box
                maxWidth: 980,
              },
              input.headline,
            ),
            box({ marginTop: 24, fontSize: 32, color: INK_SOFT }, input.detail),
          ]),
          box(
            {
              borderTop: `2px solid ${RULE}`,
              paddingTop: 26,
              alignItems: "center",
              gap: 18,
            },
            [
              box({ fontSize: 26, fontWeight: 700 }, "awesome.donld.me"),
              box({ flex: "1" }),
              ...(["active", "steady", "slowing", "dormant"] as const).flatMap(
                (level) => [
                  box({
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    background: PULSE[level],
                  }),
                  box({ fontSize: 20, color: MUTE, marginRight: 14 }, level),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

/** the finished PNG, 1200x630 */
export async function renderOgImage(input: OgCard): Promise<Buffer> {
  const svg = await satori(card(input) as never, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: await fonts(),
  });

  return new Resvg(svg, {
    // the SVG satori emits is already 1200x630 and every glyph in it is a path,
    // so resvg never needs to look at the system font database
    font: { loadSystemFonts: false },
    fitTo: { mode: "width", value: OG_WIDTH },
  })
    .render()
    .asPng();
}

/** shared by both endpoints, so a card is served the same way everywhere */
export function ogResponse(png: Buffer): Response {
  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** how fresh a list is, in the same vocabulary the pages use */
export function pulseFor(lastActivity: Date | undefined): Liveness | undefined {
  return lastActivity ? liveness(lastActivity) : undefined;
}
