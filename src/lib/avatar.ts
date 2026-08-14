import { createHash } from "node:crypto";
import sharp from "sharp";
import { prisma } from "./prisma";
import { AVATAR_SIZE } from "./avatar-url";

// Self-hosted contributor avatars (PLAN.md §17n) — the ingestion half. The
// serving half is src/app/api/avatar/[userId]/[hash]/route.ts.
//
// Server-only: `sharp` is a native module and `node:crypto` has no browser
// equivalent, so nothing here may be imported from a "use client" component.
// ContributorPanel gets the finished URL as a prop instead.

/**
 * Decompression-bomb ceiling, in pixels. sharp's own default is ~268MP,
 * which is far more than an avatar could justify: a 50MP source is already
 * a 8000×6000 photo.
 *
 * This is the *only* ingestion limit, deliberately. A byte cap used to sit
 * alongside it and was removed: bytes are a poor proxy for what decoding
 * actually costs — a 2MB PNG can be 100MP — so the pixel ceiling is both the
 * stricter and the more honest guard, and a byte cap large enough not to
 * reject legitimate photos never bound anything the pixel cap didn't.
 */
const MAX_INPUT_PIXELS = 50 * 1024 * 1024;

export const AVATAR_CONTENT_TYPE = "image/webp";

export type ProcessedAvatar = {
  // Uint8Array<ArrayBuffer>, spelled out: Prisma 7 types a `Bytes` column as
  // exactly that, while sharp hands back Node's Buffer — which is
  // Uint8Array<ArrayBufferLike>, admitting SharedArrayBuffer, and so isn't
  // assignable to it. Copying into a freshly allocated array once here keeps
  // every call site free of the cast.
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  hash: string;
  width: number;
  height: number;
};

/**
 * Normalizes arbitrary uploaded image bytes into the one shape this app
 * stores and serves.
 *
 * Three things this does that matter beyond resizing:
 *
 * - **Strips EXIF, including GPS.** Uploaded phone photos routinely carry
 *   coordinates, and this avatar is published on a public page. sharp drops
 *   metadata on re-encode unless `.withMetadata()` is called, so the strip
 *   is a consequence of re-encoding rather than a separate step — but it is
 *   the reason re-encoding is non-negotiable even for an already-small,
 *   already-square input.
 * - **Sniffs the real format.** The declared content type of an upload is
 *   attacker-controlled and is never consulted; sharp decodes the actual
 *   bytes, and anything it can't parse as an image throws here.
 * - **`.rotate()` with no argument applies the EXIF orientation flag** before
 *   that metadata is discarded. Without it, a portrait phone photo would be
 *   stored rotated 90° — the orientation is in the metadata being stripped,
 *   so it has to be baked into the pixels first.
 */
export async function processAvatar(input: Uint8Array): Promise<ProcessedAvatar> {
  let encoded: Buffer;
  try {
    encoded = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    // sharp's own messages name file paths and internal buffers; they aren't
    // useful to whoever picked the wrong file, and shouldn't be shown.
    throw new Error(`That file couldn't be read as an image. (${err instanceof Error ? err.message.split("\n")[0] : "unknown error"})`);
  }

  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return {
    bytes,
    contentType: AVATAR_CONTENT_TYPE,
    hash: avatarHash(bytes),
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  };
}

/**
 * The content hash that becomes both the URL's last path segment and the
 * ETag. Truncated to 128 bits — this is a cache key, not a security
 * boundary, and a 32-char segment keeps the URL readable in a network log.
 */
export function avatarHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Processes and stores one user's avatar, replacing any existing one.
 *
 * Shared by the self-service upload action and the sample-data seed so the
 * two can't diverge on what actually lands in the row — the same reason
 * actions/contributor.ts and actions/users.ts share contributor-links.ts's
 * validators (PLAN.md §17i). Returns the stored hash, which the caller needs
 * to build the new URL.
 */
export async function storeAvatar(userId: string, input: Uint8Array): Promise<ProcessedAvatar> {
  const processed = await processAvatar(input);
  const row = {
    bytes: processed.bytes,
    contentType: processed.contentType,
    hash: processed.hash,
    width: processed.width,
    height: processed.height,
  };
  await prisma.userAvatar.upsert({
    where: { userId },
    update: row,
    create: { userId, ...row },
  });
  return processed;
}
