// Generates the option-E "ink chip" master.png: a rounded square filled with
// a solid color, holding a centered serif glyph. Renders an SVG (rect + text)
// through sharp, so every knob below is a plain number you can tweak and
// re-run — no image editor needed.
//
// Usage (from the project root, same as scripts/build-icons.ts):
//   npx tsx scripts/gen-master-ink-chip.ts [options]
//
// Options (all optional, shown with current defaults):
//   --size 1024          canvas is size x size
//   --chip 0.88           chip edge length, as a fraction of size
//   --radius 0.22          corner radius, as a fraction of the chip edge
//   --font 0.62           glyph font-size, as a fraction of the chip edge
//   --yoffset 0.05         glyph baseline nudge, as a fraction of the chip edge
//                          (dominant-baseline="central" sits a hair high for
//                          a T's flat top/no descender, so this nudges down)
//   --glyph T              the character to draw
//   --family "Georgia, 'Times New Roman', serif"
//   --weight 700
//   --ink "#171717"        chip fill
//   --fg "#ffffff"         glyph color
//   --out master-preview.png
//
// Example — try a bigger glyph and a squarer (less rounded) chip:
//   npx tsx scripts/gen-master-ink-chip.ts --font 0.7 --radius 0.14 --out try2.png

import sharp from "sharp";

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const opts: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    opts[key] = argv[i + 1];
    i++;
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));

const SIZE = Number(args.size ?? 1024);
const CHIP_FRACTION = Number(args.chip ?? 1.00);
const RADIUS_FRACTION = Number(args.radius ?? 0.22);
const FONT_FRACTION = Number(args.font ?? 0.85);
const Y_OFFSET_FRACTION = Number(args.yoffset ?? 0.00);
const GLYPH = args.glyph ?? "T";
const FONT_FAMILY = args.family ?? "Georgia, 'Times New Roman', serif";
const FONT_WEIGHT = args.weight ?? "700";
const INK = args.ink ?? "#171717";
const FG = args.fg ?? "#ffffff";
const OUT = args.out ?? "master-preview.png";

const chip = Math.round(SIZE * CHIP_FRACTION);
const chipOffset = (SIZE - chip) / 2;
const radius = Math.round(chip * RADIUS_FRACTION);
const fontSize = Math.round(chip * FONT_FRACTION);
const textY = SIZE / 2 + chip * Y_OFFSET_FRACTION;

const svg = `
<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${chipOffset}" y="${chipOffset}" width="${chip}" height="${chip}"
        rx="${radius}" ry="${radius}" fill="${INK}"/>
  <text x="${SIZE / 2}" y="${textY}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}"
        font-size="${fontSize}" fill="${FG}" text-anchor="middle" dominant-baseline="central">${GLYPH}</text>
</svg>`;

sharp(Buffer.from(svg))
  .png()
  .toFile(OUT)
  .then((info) => console.log(`wrote ${OUT}`, info))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
