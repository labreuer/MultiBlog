import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveJoinCode,
  deriveJoinKey,
  formatJoinCode,
  hashJoinCode,
  joinCodeMatches,
  joinUrl,
  normalizeJoinCode,
} from "./code";

// docs/EMAIL.md §10, "The code" and "Testing". The point of these is what is
// refused: a code under another key, another batch or another serial, and
// typed input that is not a code.

const SECRET = "a fixed secret for the unit tests, not any instance's";
const KEY = deriveJoinKey(SECRET);
const BATCH = "cbatch0000000000000000000";
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{16}$/;

test("the key is 32 bytes, stable for one secret, and different for another", () => {
  assert.equal(KEY.length, 32);
  assert.deepEqual(deriveJoinKey(SECRET), KEY);
  assert.notDeepEqual(deriveJoinKey(SECRET + "x"), KEY);
});

test("an empty secret is refused", () => {
  assert.throws(() => deriveJoinKey(""));
});

test("the key is HKDF-SHA256 under its own label, with known answers", () => {
  assert.notDeepEqual(KEY, Buffer.from(SECRET));
  // Known answers, computed independently (RFC 5869 HKDF with an empty salt,
  // then HMAC, then Crockford base32 of the first ten bytes), so a change to
  // the salt, the label, the hash or the encoding fails here rather than
  // silently voiding every card already printed.
  assert.equal(deriveJoinCode(KEY, BATCH, 1), "1ZCB57SHDMXY1PTJ");
  assert.equal(deriveJoinCode(KEY, BATCH, 2), "RFENSSDYJZ3JKW8F");
});

test("a code is 16 characters of Crockford's alphabet", () => {
  for (let serial = 1; serial <= 200; serial++) {
    assert.match(deriveJoinCode(KEY, BATCH, serial), CANONICAL);
  }
});

test("derivation is stable for one secret, batch and serial", () => {
  assert.equal(deriveJoinCode(KEY, BATCH, 7), deriveJoinCode(KEY, BATCH, 7));
});

test("derivation changes with the secret, the batch or the serial", () => {
  const code = deriveJoinCode(KEY, BATCH, 7);
  assert.notEqual(deriveJoinCode(deriveJoinKey(SECRET + "x"), BATCH, 7), code);
  assert.notEqual(deriveJoinCode(KEY, BATCH + "x", 7), code);
  assert.notEqual(deriveJoinCode(KEY, BATCH, 8), code);
});

test("a batch's codes are all distinct", () => {
  const codes = new Set<string>();
  for (let serial = 1; serial <= 500; serial++) codes.add(deriveJoinCode(KEY, BATCH, serial));
  assert.equal(codes.size, 500);
});

test("a serial that is not a positive integer, or an empty batch id, is refused", () => {
  for (const serial of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveJoinCode(KEY, BATCH, serial), `serial ${serial}`);
  }
  assert.throws(() => deriveJoinCode(KEY, "", 1));
});

test("a code matches its own batch and serial under its own key", () => {
  const code = deriveJoinCode(KEY, BATCH, 3);
  assert.equal(joinCodeMatches(KEY, BATCH, 3, code), true);
});

test("a code from one key fails under another", () => {
  const code = deriveJoinCode(KEY, BATCH, 3);
  assert.equal(joinCodeMatches(deriveJoinKey("a rotated secret"), BATCH, 3, code), false);
});

test("a code fails under another batch or serial", () => {
  const code = deriveJoinCode(KEY, BATCH, 3);
  assert.equal(joinCodeMatches(KEY, BATCH + "x", 3, code), false);
  assert.equal(joinCodeMatches(KEY, BATCH, 4, code), false);
});

test("a non-canonical code never matches, and never throws", () => {
  const code = deriveJoinCode(KEY, BATCH, 3);
  for (const given of [formatJoinCode(code), code.toLowerCase(), code.slice(1), code + "0", ""]) {
    assert.equal(joinCodeMatches(KEY, BATCH, 3, given), false, given);
  }
});

test("the normalization table", () => {
  const cases: [string, string | null][] = [
    ["K7Q4M2XD9PFA3HTN", "K7Q4M2XD9PFA3HTN"],
    ["k7q4m2xd9pfa3htn", "K7Q4M2XD9PFA3HTN"], // case ignored
    ["K7q4-M2xD-9pFa-3HtN", "K7Q4M2XD9PFA3HTN"],
    ["K7Q4-M2XD-9PFA-3HTN", "K7Q4M2XD9PFA3HTN"], // dashes dropped
    ["K7Q4 M2XD 9PFA 3HTN", "K7Q4M2XD9PFA3HTN"], // spaces dropped
    ["  K7Q4M2XD9PFA3HTN\n", "K7Q4M2XD9PFA3HTN"], // surrounding whitespace
    ["K7Q4–M2XD‐9PFA‒3HTN", "K7Q4M2XD9PFA3HTN"], // a phone's dashes
    ["K7Q4--M2XD - 9PFA-3HTN", "K7Q4M2XD9PFA3HTN"],
    ["OOOO-oooo-0000-0000", "0000000000000000"], // O and o read as 0
    ["IIII-iiii-LLLL-llll", "1111111111111111"], // I and L read as 1
    ["K7Q4M2XD9PFA3HT", null], // 15 characters
    ["K7Q4M2XD9PFA3HTNK", null], // 17 characters
    ["", null],
    ["----", null],
    ["K7Q4M2XD9PFA3HTU", null], // U is outside Crockford's alphabet
    ["u7Q4M2XD9PFA3HTN", null],
    ["K7Q4M2XD9PFA3HT*", null],
    ["K7Q4_M2XD9PFA3HTN", null], // an underscore is not a separator
    ["K7Q4.M2XD.9PFA.3HTN", null],
    ["K7Q4M2XD9PFA3HTÉ", null], // a letter outside ASCII
    ["https://example.com/join/K7Q4M2XD9PFA3HTN", null], // a URL is not a code
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeJoinCode(input), expected, JSON.stringify(input));
  }
});

test("every derived code normalizes to itself, formatted or not, in either case", () => {
  for (let serial = 1; serial <= 100; serial++) {
    const code = deriveJoinCode(KEY, BATCH, serial);
    assert.equal(normalizeJoinCode(code), code);
    assert.equal(normalizeJoinCode(formatJoinCode(code)), code);
    assert.equal(normalizeJoinCode(formatJoinCode(code).toLowerCase()), code);
  }
});

test("formatting is four groups of four, and round-trips", () => {
  assert.equal(formatJoinCode("K7Q4M2XD9PFA3HTN"), "K7Q4-M2XD-9PFA-3HTN");
  const code = deriveJoinCode(KEY, BATCH, 9);
  assert.match(formatJoinCode(code), /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(formatJoinCode(code).replace(/-/g, ""), code);
});

test("formatting, hashing and a URL refuse a non-canonical code", () => {
  for (const bad of ["K7Q4-M2XD-9PFA-3HTN", "k7q4m2xd9pfa3htn", "K7Q4M2XD9PFA3HT", "K7Q4M2XD9PFA3HTU"]) {
    assert.throws(() => formatJoinCode(bad), bad);
    assert.throws(() => hashJoinCode(bad), bad);
    assert.throws(() => joinUrl("https://example.com", bad), bad);
  }
});

test("the hash is the SHA-256 of the canonical code, as hex", () => {
  // SHA-256("K7Q4M2XD9PFA3HTN"), computed independently.
  assert.equal(hashJoinCode("K7Q4M2XD9PFA3HTN"), SHA_OF_SAMPLE);
  const code = deriveJoinCode(KEY, BATCH, 1);
  assert.equal(hashJoinCode(code), hashJoinCode(normalizeJoinCode(formatJoinCode(code))!));
  assert.notEqual(hashJoinCode(code), hashJoinCode(deriveJoinCode(KEY, BATCH, 2)));
});

test("a join URL is the origin, /join/ and the code without dashes", () => {
  assert.equal(
    joinUrl("https://example.com", "K7Q4M2XD9PFA3HTN"),
    "https://example.com/join/K7Q4M2XD9PFA3HTN",
  );
  assert.equal(
    joinUrl("https://example.com/", "K7Q4M2XD9PFA3HTN"),
    "https://example.com/join/K7Q4M2XD9PFA3HTN",
  );
  assert.equal(
    joinUrl("http://b.localhost:3005", "K7Q4M2XD9PFA3HTN"),
    "http://b.localhost:3005/join/K7Q4M2XD9PFA3HTN",
  );
});

const SHA_OF_SAMPLE = "5f7a77d870b9cc8b6133910523ac14920467e098545cd39e2e08f5c3aa56732c";
