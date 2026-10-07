import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "./mail";

// docs/EMAIL.md §2 — the reserved-domain refusal, with a live-looking key in
// the environment and `fetch` stubbed, so "never reaches Resend" is asserted
// on the one call that would have reached it rather than read off a log. The
// refusal's whole value is that it holds when a key *is* configured, which is
// exactly the case local dev and the e2e suite never exercise.

const realFetch = globalThis.fetch;
const realEnv = { key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM };
const realLog = console.log;
let fetched: string[];

beforeEach(() => {
  fetched = [];
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  process.env.MAIL_FROM = "MultiBlog <mail@multiblog.test>";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    fetched.push(JSON.parse(String(init?.body)).to);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const [name, value] of [
    ["RESEND_API_KEY", realEnv.key],
    ["MAIL_FROM", realEnv.from],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const mail = { subject: "s", text: "t" };

for (const to of [
  "someone@example.com",
  "SOMEONE@EXAMPLE.COM",
  "sample-user@sample.invalid",
  "claude@multiblog.invalid",
  "anyone@a.b.invalid",
  "bare@invalid",
]) {
  test(`refuses ${to} without calling Resend`, async () => {
    assert.deepEqual(await sendMail({ to, ...mail }), { delivered: true });
    assert.deepEqual(fetched, []);
  });
}

for (const to of [
  "labreuer@gmail.com",
  "someone@invalid.com",
  "someone@notinvalid",
  "someone@example.com.au",
  "someone@sub.example.com",
]) {
  test(`delivers ${to} through Resend`, async () => {
    assert.deepEqual(await sendMail({ to, ...mail }), { delivered: true });
    assert.deepEqual(fetched, [to]);
  });
}
