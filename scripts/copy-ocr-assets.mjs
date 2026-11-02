// Copies the Tesseract OCR engine + English language data into public/ocr so they
// are bundled into the app. OCR then works fully offline (no CDN downloads).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const out = join(root, "public", "ocr");
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const tess = pkgDir("tesseract.js");
const core = pkgDir("tesseract.js-core");
const eng = pkgDir("@tesseract.js-data/eng");

const copies = [
  [join(tess, "dist", "worker.min.js"), join(out, "worker.min.js")],
  [join(core, "tesseract-core-lstm.wasm.js"), join(out, "core", "tesseract-core-lstm.wasm.js")],
  [join(core, "tesseract-core-simd-lstm.wasm.js"), join(out, "core", "tesseract-core-simd-lstm.wasm.js")],
  [join(eng, "4.0.0_best_int", "eng.traineddata.gz"), join(out, "lang", "eng.traineddata.gz")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`[ocr-assets] missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
}
console.log(`[ocr-assets] copied ${copies.length} OCR files to public/ocr`);
