import QRCode from "qrcode";
import { formatJoinCode, joinUrl } from "./code";

// docs/EMAIL.md §10, "Minting and printing": a batch's cards as one whole,
// printable HTML document. Business cards of 3.5 × 2 inches, ten to a US
// Letter page in the common two-by-five layout (Avery 5371/8371 and their
// kin: a half-inch top and bottom margin, three quarters of an inch either
// side, no gutters). Server and script code only; no client bundle draws a
// QR.
//
// STYLE.md's guard against color literals covers this file, so it writes
// none. The QR's modules take SVG's default fill, and the text the
// document's default color, which is the printer's ink on the paper.

export type CardSheetCard = { serial: number; code: string };

export type CardSheetInput = {
  siteTitle: string;
  /** The instance's host, as printed under the QR; the QR holds https://<host>/join/<code>. */
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

function renderCard(input: CardSheetInput, origin: string, card: CardSheetCard): string {
  const url = joinUrl(origin, card.code);
  const line = input.line ? `<p class="line">${escapeHtml(input.line)}</p>` : "";
  return `<section class="card" data-serial="${card.serial}" data-url="${escapeHtml(url)}">
${qrSvg(url, `QR code for ${url}`)}
<div class="text">
<p class="title">${escapeHtml(input.siteTitle)}</p>
${line}
<div class="redeem">
<p class="where">${escapeHtml(input.host)}/join</p>
<p class="code">${formatJoinCode(card.code)}</p>
</div>
<p class="serial">No.&nbsp;${card.serial}</p>
</div>
</section>`;
}

const CSS = `
@page { size: 8.5in 11in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 8.5in; }
body { font-family: system-ui, "Helvetica Neue", Arial, sans-serif; }
.sheet {
  width: 8.5in;
  height: 11in;
  padding: 0.5in 0.75in;
  display: grid;
  grid-template-columns: repeat(2, 3.5in);
  grid-template-rows: repeat(5, 2in);
  overflow: hidden;
  break-after: page;
}
.sheet:last-child { break-after: auto; }
.card {
  width: 3.5in;
  height: 2in;
  padding: 0.18in;
  display: grid;
  grid-template-columns: 1.4in 1fr;
  column-gap: 0.1in;
  align-items: center;
  overflow: hidden;
}
.qr { width: 1.4in; height: 1.4in; display: block; }
.text {
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  overflow-wrap: anywhere;
}
.title { font-size: 12pt; font-weight: 700; line-height: 1.25; }
.line { font-size: 8pt; line-height: 1.2; }
.where { font-size: 8pt; }
.code {
  font-family: ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace;
  font-size: 9.5pt;
  font-weight: 700;
  white-space: nowrap;
}
.serial { font-size: 6pt; text-align: right; }
@media screen {
  body { padding: 0.25in; width: auto; }
  .sheet { outline: 1px solid; margin-bottom: 0.25in; }
  .card { outline: 1px dashed; }
}
`;

/** A whole HTML document of the given cards, ten to a Letter page. */
export function renderCardSheet(input: CardSheetInput): string {
  if (input.cards.length === 0) throw new Error("No cards to print.");
  const origin = hostOrigin(input.host);
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
<style>${CSS}</style>
</head>
<body>
${sheets.join("\n")}
</body>
</html>
`;
}
