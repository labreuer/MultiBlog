// Derives every favicon/icon rendition this app serves from one master
// image (docs/FAVICON.md). Outputs are deployment content, not repository
// content — same reasoning as src/lib/site-banner.ts (PLAN.md §17b) — so
// every path this writes to is gitignored, and the "next deploy" cadence
// that implies is deliberate: see docs/FAVICON.md for why an admin-upload
// path was considered and rejected in favor of this.
//
// Usage:
//   npx tsx scripts/build-icons.ts [path/to/master.png] [--alpha-to-color=white|black|#rrggbb]
//
// Master path defaults to site-icons/master.png. The master should be
// square-ish art on a transparent background.
//
// Transparency is kept wherever the consuming platform actually honors it;
// --alpha-to-color is composited in only where it doesn't (see each output
// below for which, and why those two specifically can't be transparent
// regardless of what the PNG format itself supports). Defaults to white.
// Whether a given master's own artwork reads clearly once its background
// really is transparent (rather than plated) is a property of that artwork,
// not of this script — compare the output against light and dark
// surroundings and pick different source art, or a specific
// --alpha-to-color, if it doesn't.
//
// What this writes, and why each exists:
//   src/app/icon.png          32×32, transparent — Next content-hashes this
//                                       into the emitted <link>'s href
//                                       (verified against next@16.2.11's
//                                       next-metadata-image-loader.js); that
//                                       hash is the entire cache-busting
//                                       strategy this script exists to serve.
//   src/app/icon1.png         16×16, transparent — same hashing, Next's
//                                       numbered-suffix convention for a
//                                       second same-type icon. This is the
//                                       one rendition a downscale genuinely
//                                       can't do well — see SIMPLIFY_16
//                                       below.
//   src/app/apple-icon.png    180×180, --alpha-to-color — iOS composites its
//                                       own rounded-corner mask and fills
//                                       transparent pixels with black rather
//                                       than the device's actual background,
//                                       so this is one of the two outputs
//                                       that can't be transparent regardless
//                                       of what the format supports.
//   public/favicon.ico        16/32/48, square frames, PNG-compressed,
//                                       transparent — real per-pixel alpha
//                                       in a PNG-compressed ICO frame
//                                       renders fine in modern browsers and
//                                       Windows (verified against a
//                                       real-world favicon.ico using this
//                                       exact shape). Deliberately NOT
//                                       src/app/favicon.ico:
//                                       resolve-metadata.js unshifts that
//                                       file to the FRONT of the icon list,
//                                       which would put an unhashed URL back
//                                       in front of browsers and reopen the
//                                       exact staleness problem
//                                       docs/FAVICON.md exists to avoid.
//   public/icons/icon-{192,512}.png       "any" purpose manifest icons,
//                                       transparent — the manifest spec
//                                       doesn't require these to fill the
//                                       square.
//   public/icons/maskable-{192,512}.png   "maskable" purpose,
//                                       --alpha-to-color, full bleed — the
//                                       other output that can't be
//                                       transparent: the spec requires a
//                                       maskable icon to fill its full
//                                       bleed, since the OS crops it to a
//                                       squircle/circle and transparent
//                                       pixels outside the safe zone would
//                                       show through as a hole rather than
//                                       background. Glyph kept inside the
//                                       ~80% safe-zone circle that crop
//                                       respects.
//
// manifest.ts reads the two public/icons/ files itself and appends its own
// content-hash query param, since files under public/ get none of Next's
// automatic hashing — see that file for why. It also hardcodes the
// manifest's theme_color/background_color to match whatever
// --alpha-to-color produces here; the two aren't derived from a shared
// source, so a non-default --alpha-to-color needs manifest.ts's
// BACKGROUND_COLOR updated by hand to stay consistent.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type Sharp } from "sharp";

const ROOT = path.resolve(__dirname, "..");

const NAMED_COLORS: Record<string, { r: number; g: number; b: number }> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
};

function parseAlphaToColor(raw: string): { r: number; g: number; b: number; alpha: 1 } {
  const named = NAMED_COLORS[raw.toLowerCase()];
  if (named) return { ...named, alpha: 1 };

  const hex = raw.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(
      `--alpha-to-color must be "white", "black", or a 6-digit hex value like "#1a1a1a" (got "${raw}").`,
    );
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    alpha: 1,
  };
}

function parseArgs(argv: string[]): { masterArg: string | undefined; alphaToColorArg: string | undefined } {
  let masterArg: string | undefined;
  let alphaToColorArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--alpha-to-color=")) {
      alphaToColorArg = arg.slice("--alpha-to-color=".length);
    } else if (arg === "--alpha-to-color") {
      alphaToColorArg = argv[++i];
    } else if (!arg.startsWith("--")) {
      masterArg = arg;
    }
  }

  return { masterArg, alphaToColorArg };
}

const { masterArg, alphaToColorArg } = parseArgs(process.argv.slice(2));
const masterPath = path.resolve(ROOT, masterArg ?? "site-icons/master.png");

// Composited in only for the two renditions that can't be transparent
// (apple-icon.png, the maskable manifest icons) — see the header comment for
// why those two specifically.
const ALPHA_TO_COLOR = parseAlphaToColor(alphaToColorArg ?? "white");

// A lift applied to the glyph before compositing, independent of
// --alpha-to-color: a source image with a very dark interior fill halftones
// into mud at 16–32px without one, whether the pixels around it end up
// transparent or opaque. If a given master doesn't need this, it's a no-op
// modulate; it isn't worth gating behind another flag for that alone.
const BRIGHTNESS = 1.9;
const SATURATION = 1.35;

async function transparentSquare(glyph: Sharp, size: number, insetFraction: number): Promise<Buffer> {
  const inner = Math.round(size * insetFraction);
  const resized = await glyph
    .clone()
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toBuffer();
}

async function opaqueSquare(glyph: Sharp, size: number, insetFraction: number): Promise<Buffer> {
  const inner = Math.round(size * insetFraction);
  const resized = await glyph
    .clone()
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  // flatten() alone still leaves a constant-255 alpha channel in the output
  // PNG (verified) — removeAlpha() is what actually drops the channel,
  // which matters for apple-icon.png specifically: iOS is documented to
  // expect none at all, not merely an opaque one.
  return sharp({ create: { width: size, height: size, channels: 4, background: ALPHA_TO_COLOR } })
    .composite([{ input: resized, gravity: "center" }])
    .flatten({ background: ALPHA_TO_COLOR })
    .removeAlpha()
    .png()
    .toBuffer();
}

// A minimal ICO container wrapping PNG-compressed frames — the same shape
// modern browsers and Windows accept (verified against a real-world
// favicon.ico, which uses this exact PNG-in-ICO structure with a true alpha
// channel). Avoids adding a dependency for something this small.
function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = frames.length * dirEntrySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(dirSize);
  let offset = headerSize + dirSize;
  frames.forEach((frame, i) => {
    const o = i * dirEntrySize;
    const dim = frame.size >= 256 ? 0 : frame.size; // 0 means 256 in ICO
    dir.writeUInt8(dim, o); // width
    dir.writeUInt8(dim, o + 1); // height
    dir.writeUInt8(0, o + 2); // color count (0 = no palette)
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(frame.png.byteLength, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += frame.png.byteLength;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

async function main() {
  const masterBytes = await readFile(masterPath);
  const master = sharp(masterBytes).modulate({ brightness: BRIGHTNESS, saturation: SATURATION });

  await mkdir(path.join(ROOT, "src/app"), { recursive: true });
  await mkdir(path.join(ROOT, "public/icons"), { recursive: true });

  // src/app/icon.png (32×32) — a light inset keeps the glyph's outer
  // extremities from touching the edge at browser-tab scale.
  await writeFile(path.join(ROOT, "src/app/icon.png"), await transparentSquare(master, 32, 0.92));

  // src/app/icon1.png (16×16) — SIMPLIFY_16: this is a downscale, not a
  // redrawn glyph, and for detailed source art it shows: fine detail mostly
  // disappears at 16px and what survives is the gross silhouette. A heavier
  // inset (fewer stray pixels at the edge) and a slightly higher lift than
  // the 32px version are the only two knobs available here without
  // hand-drawing a simplified mark. If this still reads as a blob once
  // shipped, replace this file directly — nothing else in the pipeline
  // depends on it being generated.
  const icon16 = sharp(masterBytes).modulate({ brightness: BRIGHTNESS + 0.3, saturation: SATURATION });
  await writeFile(path.join(ROOT, "src/app/icon1.png"), await transparentSquare(icon16, 16, 0.96));

  // src/app/apple-icon.png (180×180) — see the header comment for why this
  // one can't be transparent. Extra inset versus the browser-tab icons
  // because iOS applies its own rounded-corner mask on top, which would
  // otherwise clip the glyph's corners.
  await writeFile(path.join(ROOT, "src/app/apple-icon.png"), await opaqueSquare(master, 180, 0.8));

  // public/favicon.ico — transparent square frames at the three sizes that
  // matter for the bare-URL fallback (see the header comment for why this
  // one isn't src/app/favicon.ico).
  const icoFrames = await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      png: await transparentSquare(size === 16 ? icon16 : master, size, size === 16 ? 0.96 : 0.92),
    })),
  );
  await writeFile(path.join(ROOT, "public/favicon.ico"), buildIco(icoFrames));

  // public/icons/icon-{192,512}.png — manifest "any" purpose, transparent,
  // same treatment as the browser-tab icons at a larger canvas.
  for (const size of [192, 512]) {
    await writeFile(path.join(ROOT, `public/icons/icon-${size}.png`), await transparentSquare(master, size, 0.85));
  }

  // public/icons/maskable-{192,512}.png — full bleed; see the header
  // comment for why maskable specifically can't be transparent. 0.62 inset
  // keeps the glyph inside roughly the inner 80% so a squircle/circle crop
  // doesn't clip it, with real margin past that 80% safe-zone floor rather
  // than sitting right on it.
  for (const size of [192, 512]) {
    await writeFile(path.join(ROOT, `public/icons/maskable-${size}.png`), await opaqueSquare(master, size, 0.62));
  }

  const setHash = createHash("sha256").update(masterBytes).digest("hex").slice(0, 12);
  console.log(`Built icon set from ${path.relative(ROOT, masterPath)} (master hash ${setHash}).`);
  console.log("Outputs (all gitignored — see docs/FAVICON.md):");
  console.log("  src/app/icon.png, src/app/icon1.png (transparent), src/app/apple-icon.png (--alpha-to-color)");
  console.log("  public/favicon.ico (transparent)");
  console.log("  public/icons/icon-192.png, icon-512.png (transparent)");
  console.log("  public/icons/maskable-192.png, maskable-512.png (--alpha-to-color)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
