// The two shared libraries Playwright's WebKit build needs and Fedora cannot
// supply, added to the browser bundle's own library directory.
//
//   npm run setup:webkit-libs
//
// **Why this exists at all.** Playwright ships one Linux WebKit build per
// *distro*, and there is no Fedora one — `playwright install webkit` prints
// "your OS is not officially supported; downloading fallback build for
// ubuntu24.04-x64" and hands you a bundle linked against Ubuntu 24.04's
// library versions. Most of what it needs it carries itself, in
// `~/.cache/ms-playwright/webkit-<rev>/minibrowser-{wpe,gtk}/`: `lib/` for
// WebKit's own (libWPEWebKit, libjavascriptcoregtk) and `sys/lib/` for the
// distro libraries it declines to depend on the host for (libsoup, libjxl,
// libbrotli, libbacktrace). Three are left to the host, and of those three:
//
//   libmanette-0.2.so.0          Fedora has it — `sudo dnf install libmanette`.
//   libicu{uc,i18n,data}.so.74   Fedora 44 ships ICU 77 and nothing older.
//   libjpeg.so.8                 Fedora ships libjpeg-turbo's .so.62 ABI.
//
// The last two have **no Fedora package at any version**, and neither is a
// symlink away from what is installed: ICU version-suffixes every exported
// symbol (`u_strlen_74` vs `u_strlen_77`), and libjpeg's 6b and 8 ABIs differ
// in struct layout. So Ubuntu's copies have to come from Ubuntu — the pinned
// `.deb`s below, cached in `.playwright-libs/`.
//
// **Where they then go is the part that is easy to get wrong, and did.** The
// obvious home is LD_LIBRARY_PATH, exported around the run. It does not work,
// and it fails *late*: Playwright's pre-flight `ldd` check reads the variable
// and passes, then every test dies in `browserType.launch` with
//
//   MiniBrowser: error while loading shared libraries: libicudata.so.74
//
// because the bundle's launcher is a shell script that does
// `export LD_LIBRARY_PATH="${MYDIR}/lib:${MYDIR}/sys/lib"` — an assignment,
// not an append. Whatever the caller set is gone by the time the ELF loader
// runs. So the libraries go **into `sys/lib` itself**, which is exactly the
// directory that line points at and exactly what it is for: the missing
// members of a bundle that is otherwise complete. Nothing is installed
// system-wide, nothing sits in front of the system ICU for any other program,
// and no environment variable has to survive a wrapper.
//
// The cost is that `playwright install --force webkit`, or a `pdfjs`-style
// version bump that pulls a new webkit revision, wipes them — re-run this
// script, which is cheap because `.playwright-libs/` is already populated.
// `webkitLibsStaged()` looks at the bundle, not at the cache, so
// playwright.config.ts notices the wipe rather than trusting the download.
//
// Firefox needs none of this — its build runs on Fedora 44 as downloaded.
import { webkit } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Download cache for the extracted `.so` files. Gitignored. */
export const WEBKIT_LIB_DIR = resolve(process.cwd(), ".playwright-libs");

// Pinned rather than "whatever the pool's newest is", so a WebKit run that
// worked yesterday works today. If one of these 404s, Ubuntu has superseded
// it: list the pool directory (drop the filename from the URL) and bump the
// version here — any build of the same soname will do, these are ABI-frozen.
const PACKAGES: ReadonlyArray<{ deb: string; keep: RegExp }> = [
  {
    deb: "http://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb",
    keep: /^libicu(uc|i18n|data)\.so\.74/,
  },
  {
    deb: "http://archive.ubuntu.com/ubuntu/pool/main/libj/libjpeg-turbo/libjpeg-turbo8_2.1.5-2ubuntu2_amd64.deb",
    keep: /^libjpeg\.so\.8/,
  },
];

/** The sonames the bundle's loader must find once staging is done. */
const REQUIRED = ["libicuuc.so.74", "libicui18n.so.74", "libicudata.so.74", "libjpeg.so.8"];

/**
 * The `sys/lib` directories inside the installed WebKit bundle — one per
 * front end: `minibrowser-wpe` is the headless one Playwright launches with
 * `--headless`, `minibrowser-gtk` the headed one `--headed` gets. Both need
 * the libraries, because which of the two runs is a per-run flag.
 *
 * Empty when WebKit isn't installed at all.
 */
function bundleLibDirs(): string[] {
  let root: string;
  try {
    root = dirname(webkit.executablePath()); // .../webkit-<rev>/pw_run.sh
  } catch {
    return [];
  }
  return ["minibrowser-wpe", "minibrowser-gtk"].map((front) => join(root, front, "sys", "lib")).filter((dir) => existsSync(dir));
}

/** True once every soname in {@link REQUIRED} is in every bundle front end. */
export function webkitLibsStaged(): boolean {
  const dirs = bundleLibDirs();
  if (!dirs.length) return false;
  return dirs.every((dir) => {
    const have = new Set(readdirSync(dir));
    return REQUIRED.every((so) => have.has(so));
  });
}

/** Whether the dynamic loader can already see `soname` system-wide. */
function inLdCache(soname: string): boolean {
  try {
    return execFileSync("/sbin/ldconfig", ["-p"], { encoding: "utf8" }).includes(soname);
  } catch {
    return false;
  }
}

/**
 * Environment additions for a WebKit run, or `{}` on a host where this file
 * has nothing to offer — a Debian-family box, or a Fedora one where
 * `npm run setup:webkit-libs` / `dnf install libmanette` have not both been
 * done. Returning nothing rather than throwing is deliberate: the run should
 * then fail with Playwright's own "missing dependencies" box, which names
 * exactly what is absent, rather than with a message of ours.
 *
 * **There is deliberately no LD_LIBRARY_PATH here** — the bundle's launcher
 * overwrites it, which is why the libraries live in `sys/lib` instead; the
 * header has the whole story. What is left is one flag, for one library.
 * Once the staging and libmanette are both in place, Playwright's pre-flight
 * `ldd` scan still fails the run over `libx264.so`, which it maps to
 * `gstreamer1.0-libav`. That library is h.264 playback, dlopen'd at need and
 * never on the path any test here takes; on Fedora it means enabling RPM
 * Fusion Free for a codec no spec plays. So the flag is set only in the one
 * state where we have checked the load-bearing libraries ourselves and the
 * sole remaining complaint is that one. Anywhere else the check stays on.
 */
export function webkitLaunchEnv(): Record<string, string> {
  if (!webkitLibsStaged() || !inLdCache("libmanette-0.2.so.0")) return {};
  return { PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1" };
}

/** Fill {@link WEBKIT_LIB_DIR} from the pinned `.deb`s, unless it already is. */
async function download(): Promise<void> {
  if (REQUIRED.every((so) => existsSync(join(WEBKIT_LIB_DIR, so)))) {
    console.log(`Already cached in ${WEBKIT_LIB_DIR}.`);
    return;
  }
  mkdirSync(WEBKIT_LIB_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "webkit-libs-"));
  try {
    for (const { deb, keep } of PACKAGES) {
      const file = deb.slice(deb.lastIndexOf("/") + 1);
      console.log(`Fetching ${file}`);
      const res = await fetch(deb);
      if (!res.ok) {
        throw new Error(`${deb} -> HTTP ${res.status}. Ubuntu has probably superseded this version; see the note above PACKAGES in scripts/webkit-libs.ts.`);
      }
      const unpack = join(work, file.replace(/\.deb$/, ""));
      mkdirSync(unpack, { recursive: true });
      writeFileSync(join(unpack, file), Buffer.from(await res.arrayBuffer()));
      // A .deb is an `ar` archive of three members; the payload is data.tar.*,
      // compressed with zstd on current Ubuntu. GNU tar sniffs the compression
      // itself, so `-xf` needs no per-format flag.
      execFileSync("ar", ["x", file], { cwd: unpack, stdio: "inherit" });
      const payload = readdirSync(unpack).find((f) => f.startsWith("data.tar"));
      if (!payload) throw new Error(`no data.tar member in ${file}`);
      execFileSync("tar", ["-xf", payload], { cwd: unpack, stdio: "inherit" });

      const libDir = join(unpack, "usr/lib/x86_64-linux-gnu");
      for (const entry of readdirSync(libDir)) {
        if (keep.test(entry)) copyInto(join(libDir, entry), WEBKIT_LIB_DIR, entry);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Copy one library into `dir`, preserving whether it is a symlink. The
 * sonames the loader looks for (`libicuuc.so.74`) are links to the real files
 * (`libicuuc.so.74.2`); resolving them would give two full copies and no
 * soname, so both ends of each pair come across as they are.
 */
function copyInto(from: string, dir: string, name: string): void {
  const to = join(dir, name);
  rmSync(to, { force: true });
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else copyFileSync(from, to);
  console.log(`  ${to}`);
}

async function stage(): Promise<void> {
  if (process.platform !== "linux") {
    console.log(`Nothing to do on ${process.platform} — this is a Linux loader problem.`);
    return;
  }
  await download();

  const dirs = bundleLibDirs();
  if (!dirs.length) throw new Error("WebKit isn't installed — run `npm run setup:browsers` first.");
  const cached = readdirSync(WEBKIT_LIB_DIR);
  for (const dir of dirs) {
    for (const entry of cached) copyInto(join(WEBKIT_LIB_DIR, entry), dir, entry);
  }

  if (!webkitLibsStaged()) throw new Error(`copied, but ${REQUIRED.join(", ")} are still not all present in ${dirs.join(", ")}`);
  console.log("\nWebKit's bundle is complete.");
  if (!inLdCache("libmanette-0.2.so.0")) {
    console.log("One host package is still missing (see e2e/README.md, 'Firefox and WebKit'):");
    console.log("    sudo dnf install libmanette");
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/webkit-libs.ts")) {
  stage().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
