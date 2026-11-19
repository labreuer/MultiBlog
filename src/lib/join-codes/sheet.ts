import QRCode from "qrcode";
import { formatJoinCode, joinUrl } from "./code";

// docs/EMAIL.md §10, "Minting and printing": a batch's cards as one whole,
// printable HTML document, for plain paper cut by hand. Ten cards to a US
// Letter page, two by five, 3.5 inches wide, set apart so every cut has room
// on both sides (the constants beside the CSS say how far). A card's height
// is what is left of the page once the margins and gaps are taken, about 1.81
// inches. Server and script code only; no client bundle draws a QR.
//
// STYLE.md's guard against color literals covers this file, so it writes
// none. The QR's modules take SVG's default fill, and the text the
// document's default color, which is the printer's ink on the paper.

export type CardSheetCard = { serial: number; code: string };

export type CardSheetInput = {
  /** The document's title, on screen; the cards name the host instead. */
  siteTitle: string;
  /** The instance's host, subdomain and all, as the card welcomes to and printed under the QR; the QR holds https://<host>/join/<code>. */
  host: string;
  /** An optional line of text given at printing. */
  line?: string;
  cards: CardSheetCard[];
};

export const CARDS_PER_PAGE = 10;

// Error-correction level M recovers about 15% of the symbol: enough for a
// smudge or a crease on a card that has been in a pocket, while keeping the
// symbol at the smallest version the URL allows. The encoder splits the URL
// into a byte segment and an alphanumeric one for the code, so a host of up
// to 16 characters takes version 3 (29 modules), and one of 17 to 36 takes
// version 4 (33 modules).
const ERROR_CORRECTION = "M";

// The standard asks for a quiet zone of four modules round the symbol. It is
// drawn as part of the SVG's box rather than left to the card's padding, so
// the QR's printed size includes it and no layout change can eat into it.
const QUIET_ZONE = 4;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The printed size of a QR, its quiet zone included. */
const QR_SIZE_IN = 1.4;

/**
 * How far inside its box a QR's dark modules start, in inches: the quiet
 * zone's share of the box. The text beside it is inset by the same, so its
 * first cap and its code's baseline line up with the symbol's top and bottom
 * edges rather than with its white border.
 */
export function qrQuietInsetIn(text: string): number {
  const { size } = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION }).modules;
  return (QUIET_ZONE / (size + 2 * QUIET_ZONE)) * QR_SIZE_IN;
}

/** The QR for `text` as an inline SVG: one path, one horizontal run of dark modules per subpath. */
export function qrSvg(text: string, label: string): string {
  const symbol = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION });
  const { size, data } = symbol.modules;
  let d = "";
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y * size + x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  const box = size + 2 * QUIET_ZONE;
  return (
    `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="${-QUIET_ZONE} ${-QUIET_ZONE} ${box} ${box}"` +
    ` shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(label)}"` +
    ` data-version="${symbol.version}" data-modules="${size}"><path d="${d}"/></svg>`
  );
}

function hostOrigin(host: string): string {
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    throw new Error(`Not a host: ${host}`);
  }
  if (url.host !== host.toLowerCase()) throw new Error(`Not a host: ${host}`);
  return url.origin;
}

/** What every card says above its code. */
export const CARD_INVITATION = "Use this code to create an account and try it out.";

/**
 * The host as one inline block, so it moves to a line of its own whole
 * rather than splitting after "dev."; inside it a break is allowed after
 * each dot, for a host too long for the column.
 */
function hostBlock(host: string): string {
  return `<span class="host">${escapeHtml(host).replace(/\./g, ".<wbr>")}!</span>`;
}

function renderCard(input: CardSheetInput, origin: string, card: CardSheetCard): string {
  const url = joinUrl(origin, card.code);
  const line = input.line ? `<p class="line">${escapeHtml(input.line)}</p>` : "";
  return `<section class="card" data-serial="${card.serial}" data-url="${escapeHtml(url)}">
${qrSvg(url, `QR code for ${url}`)}
<div class="text">
<div class="greeting">
<p class="title">Welcome to ${hostBlock(input.host)}</p>
<p class="invitation">${CARD_INVITATION}</p>
${line}
</div>
<div class="redeem">
<p class="where">${escapeHtml(input.host)}/join</p>
<p class="code">${formatJoinCode(card.code)}</p>
</div>
</div>
<p class="serial">No.&nbsp;${card.serial}</p>
</section>`;
}

// The inset of a card's text from its edge. Two cards one above the other
// are twice it apart. Across the page, the gap between the two columns is
// twice the side margin, so the white space between them is twice what is
// at either edge, counted from the cards' edges or from their ink alike:
// two 3.5-inch columns leave 1.5 inches, which makes three eighths of an
// inch each side and three quarters between. Top and bottom, a quarter inch.
const CARD_WIDTH_IN = 3.5;
const CARD_INSET_IN = 0.18;
const ROW_GAP_IN = 2 * CARD_INSET_IN;
const SIDE_MARGIN_IN = (8.5 - 2 * CARD_WIDTH_IN) / 4;
const COLUMN_GAP_IN = 2 * SIDE_MARGIN_IN;

// The number sits below the text, in the card's padding: clear of the code,
// and this far from the cut line.
const SERIAL_FROM_CUT_IN = 0.09;

/**
 * The sheet's style. `quietInsetIn` is qrQuietInsetIn's for its cards, which
 * is one figure for a whole sheet: every card's URL is its host's and a code
 * of one length, so every QR is the same version.
 *
 * `text-box` trims the leading above the welcome's caps and below the code's
 * baseline, so the text block's ink, and not its line boxes, meets the QR's
 * top and bottom edges. A browser without it (Firefox, as of this writing)
 * prints the text a point or two inside them.
 */
const css = (quietInsetIn: number) => `
@page { size: 8.5in 11in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 8.5in; }
body { font-family: system-ui, "Helvetica Neue", Arial, sans-serif; }
.sheet {
  width: 8.5in;
  height: 11in;
  padding: 0.25in ${SIDE_MARGIN_IN}in;
  display: grid;
  grid-template-columns: repeat(2, ${CARD_WIDTH_IN}in);
  grid-template-rows: repeat(5, 1fr);
  row-gap: ${ROW_GAP_IN}in;
  column-gap: ${COLUMN_GAP_IN}in;
  overflow: hidden;
  break-after: page;
}
.sheet:last-child { break-after: auto; }
.card {
  position: relative;
  width: 3.5in;
  height: 100%;
  padding: ${CARD_INSET_IN}in;
  display: grid;
  grid-template-columns: ${QR_SIZE_IN}in 1fr;
  column-gap: 0.1in;
  align-items: center;
  overflow: hidden;
}
.qr { width: ${QR_SIZE_IN}in; height: ${QR_SIZE_IN}in; display: block; }
.text {
  height: ${QR_SIZE_IN}in;
  padding-block: ${quietInsetIn.toFixed(4)}in;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  overflow-wrap: anywhere;
}
.title {
  font-size: 10pt;
  font-weight: 700;
  line-height: 1.2;
  text-box-trim: trim-start;
  text-box-edge: cap alphabetic;
  /* Ascenders rise above the cap height the trim meets; this brings the
     tallest ink, the l and the t, down to the QR's top, within a fifth of a
     point. Measured on a Chromium print in Noto Sans, so it is one face's
     figure, near enough for the sans faces the stack names. Relative, so it
     moves nothing else. */
  position: relative; top: 0.07em;
}
.host { display: inline-block; }
.invitation, .line { font-size: 7.5pt; line-height: 1.25; margin-top: 0.03in; }
.where { font-size: 8pt; }
.code {
  font-family: ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace;
  font-size: 9.5pt;
  font-weight: 700;
  white-space: nowrap;
  text-box-trim: trim-end;
  text-box-edge: cap alphabetic;
}
.serial {
  position: absolute;
  right: ${CARD_INSET_IN}in;
  bottom: ${SERIAL_FROM_CUT_IN}in;
  font-size: 6pt;
  line-height: 1;
}
@media screen {
  body { padding: 0.25in; width: auto; }
  .sheet { outline: 1px solid; margin-bottom: 0.25in; }
}
`;

/** A whole HTML document of the given cards, ten to a Letter page. */
export function renderCardSheet(input: CardSheetInput): string {
  if (input.cards.length === 0) throw new Error("No cards to print.");
  const origin = hostOrigin(input.host);
  const quietInsetIn = qrQuietInsetIn(joinUrl(origin, input.cards[0].code));
  const sheets: string[] = [];
  for (let i = 0; i < input.cards.length; i += CARDS_PER_PAGE) {
    const cards = input.cards.slice(i, i + CARDS_PER_PAGE);
    sheets.push(`<div class="sheet">\n${cards.map((c) => renderCard(input, origin, c)).join("\n")}\n</div>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.siteTitle)}: join cards</title>
<style>${css(quietInsetIn)}</style>
</head>
<body>
${sheets.join("\n")}
</body>
</html>
`;
}
