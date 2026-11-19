import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveJoinCode, deriveJoinKey, formatJoinCode } from "./code";
import { CARD_INVITATION, qrQuietInsetIn, qrSvg, renderCardSheet } from "./sheet";

// docs/EMAIL.md §10, "Minting and printing". Whether a printed QR scans is
// checked by rendering and decoding a sheet (scripts/join-codes/demo-sheet.ts);
// these cover the document's shape and what it refuses.

const KEY = deriveJoinKey("a fixed secret for the unit tests, not any instance's");
const cards = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ serial: i + 1, code: deriveJoinCode(KEY, "cb", i + 1) }));

const count = (html: string, needle: string) => html.split(needle).length - 1;

test("ten cards to a page", () => {
  for (const [n, pages] of [[1, 1], [10, 1], [11, 2], [20, 2], [21, 3]] as const) {
    const html = renderCardSheet({ siteTitle: "T", host: "example.com", cards: cards(n) });
    assert.equal(count(html, `<div class="sheet">`), pages, `${n} cards`);
    assert.equal(count(html, `<section class="card"`), n, `${n} cards`);
  }
});

test("each card carries its URL, its grouped code, its serial and the host", () => {
  const [card] = cards(1);
  const html = renderCardSheet({ siteTitle: "T", host: "example.com", cards: [card] });
  assert.ok(html.includes(`data-url="https://example.com/join/${card.code}"`));
  assert.ok(html.includes(`<p class="code">${formatJoinCode(card.code)}</p>`));
  assert.ok(html.includes("No.&nbsp;1<"));
  assert.ok(html.includes("example.com/join<"));
  assert.ok(html.startsWith("<!doctype html>"));
});

test("each card welcomes to the host, subdomain and all, and asks for the code to be used", () => {
  const html = renderCardSheet({ siteTitle: "Thicketry (dev)", host: "dev.thicketry.org", cards: cards(2) });
  const welcome = `Welcome to <span class="host">dev.<wbr>thicketry.<wbr>org!</span>`;
  assert.equal(count(html, welcome), 2);
  assert.equal(count(html, CARD_INVITATION), 2);
  // The site title names the document, not the cards.
  assert.equal(count(html, "Thicketry (dev)"), 1);
  assert.ok(html.includes("<title>Thicketry (dev): join cards</title>"));
});

test("columns are twice the side margin apart, rows twice the text's inset, with no cut lines drawn", () => {
  const html = renderCardSheet({ siteTitle: "T", host: "example.com", cards: cards(1) });
  assert.ok(html.includes("padding: 0.18in;"));
  assert.ok(html.includes("row-gap: 0.36in;"));
  assert.ok(html.includes("padding: 0.25in 0.375in;"));
  assert.ok(html.includes("column-gap: 0.75in;"));
  assert.ok(html.includes("grid-template-columns: repeat(2, 3.5in);"));
  assert.ok(!/dashed|dotted/.test(html));
});

test("the text is inset by the QR's quiet zone, and the number sits outside it", () => {
  const html = renderCardSheet({ siteTitle: "T", host: "example.com", cards: cards(1) });
  const url = `https://example.com/join/${cards(1)[0].code}`;
  // Version 3 for this host: 29 modules and 4 of quiet zone either side.
  assert.equal(qrQuietInsetIn(url), (4 / 37) * 1.4);
  assert.ok(html.includes(`padding-block: ${((4 / 37) * 1.4).toFixed(4)}in;`));
  assert.ok(html.includes("text-box-trim: trim-start;"));
  assert.ok(html.includes("text-box-trim: trim-end;"));
  assert.match(html, /<\/div>\n<\/div>\n<p class="serial">No.&nbsp;1<\/p>\n<\/section>/);
});

test("the optional line appears only when given", () => {
  const without = renderCardSheet({ siteTitle: "T", host: "example.com", cards: cards(2) });
  assert.equal(count(without, `class="line"`), 0);
  const withLine = renderCardSheet({ siteTitle: "T", host: "example.com", line: "Hi", cards: cards(2) });
  assert.equal(count(withLine, `<p class="line">Hi</p>`), 2);
});

test("text given at printing is escaped", () => {
  const html = renderCardSheet({
    siteTitle: `<script>alert("t")</script>`,
    host: "example.com",
    line: `a & b <i>`,
    cards: cards(1),
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("a &amp; b &lt;i&gt;"));
});

test("a host that is not a bare host, no cards, or a non-canonical code is refused", () => {
  for (const host of ["example.com/path", "https://example.com", "exa mple.com", ""]) {
    assert.throws(() => renderCardSheet({ siteTitle: "T", host, cards: cards(1) }), host);
  }
  assert.throws(() => renderCardSheet({ siteTitle: "T", host: "example.com", cards: [] }));
  assert.throws(() =>
    renderCardSheet({
      siteTitle: "T",
      host: "example.com",
      cards: [{ serial: 1, code: "K7Q4-M2XD-9PFA-3HTN" }],
    }),
  );
});

test("the QR is one path in the default fill, with a four-module quiet zone", () => {
  // A host of 17 to 36 characters needs version 4 at level M; a shorter one, 3.
  const svg = qrSvg("https://explore.example.org/join/K7Q4M2XD9PFA3HTN", "x");
  assert.equal(count(svg, "<path "), 1);
  assert.ok(!/fill=|stroke=|style=/.test(svg));
  assert.ok(svg.includes(`data-version="4"`));
  assert.ok(svg.includes(`data-modules="33"`));
  assert.ok(svg.includes(`viewBox="-4 -4 41 41"`));
  assert.ok(qrSvg("https://example.com/join/K7Q4M2XD9PFA3HTN", "x").includes(`data-version="3"`));
});

test("the document writes no color literal", () => {
  // STYLE.md's rule: no hex or named color in src/ outside the token files.
  // The QR takes SVG's default fill and the text the document's default color.
  const html = renderCardSheet({ siteTitle: "T", host: "example.com", line: "L", cards: cards(12) });
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(html.replace(/&#39;/g, "")), "a hex color");
  // No property that takes a color is set at all, so no named one can be.
  assert.ok(!/(^|[\s;{"])(color|background(-color)?|fill|stroke|border(-color)?)\s*[:=]/im.test(html), "a color property");
  assert.ok(!/rgba?\(|hsla?\(/i.test(html), "a functional color");
});
