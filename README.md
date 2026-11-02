# Evolve AP Invoice OCR

A desktop app for Windows and macOS that reads supplier invoices (PDF or images), extracts the key fields with local OCR, lets you review and correct them in an editable worksheet, and exports the result to Excel and PDF.

- **Windows: single `.exe`**, **Mac: `.dmg`** (Apple Silicon + Intel). Double-click to run. No Command Prompt, no Python, no extra installs.
- **Offline**: OCR runs inside the app (Tesseract, English). Documents never leave the computer.
- **Built with** TypeScript + Tauri 2.

## Getting the app

The `.exe` is built automatically by GitHub Actions on a clean Windows machine, so you don't need Rust, Node or Visual Studio on your own PC.

1. Open the repository on GitHub, go to **Actions** and choose **Build desktop apps**.
2. Click the latest green run.
3. Under **Artifacts**, download **Evolve-AP-Invoice-OCR-portable** (a zip file).
4. Extract `Evolve-AP-Invoice-OCR.exe` and move it to your Desktop.
5. Double-click it.

On first launch, Windows SmartScreen may say *"Windows protected your PC"* because the app is not code-signed. Click **More info → Run anyway**. This only happens once.

Requirements: Windows 10 or 11 (64-bit). The app uses Microsoft Edge WebView2, which is already part of Windows 10/11. On an old machine without it, use the **installer** artifact (`Evolve-AP-Invoice-OCR-Setup.exe`), which installs WebView2 automatically.

### Mac

1. From the same Actions run, download **Evolve-AP-Invoice-OCR-mac** and unzip it to get `Evolve-AP-Invoice-OCR-mac.dmg`.
2. Open the `.dmg` and drag **Evolve AP Invoice OCR** into **Applications**.
3. First launch only: the app is not signed with an Apple Developer ID, so macOS blocks it. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the message about the app, then confirm.
   If macOS says the app *"is damaged and can't be opened"*, run this once in Terminal, then open the app again:
   `xattr -cr "/Applications/Evolve AP Invoice OCR.app"`

Requirements: macOS 10.15 (Catalina) or later. To remove these warnings, the app needs signing and notarization with an Apple Developer account (US$99/year), which can be added to the workflow later.

To publish a downloadable release instead of an artifact, push a tag such as `v1.0.0`. The workflow attaches both `.exe` files to a GitHub Release.

## Using the app

1. **Sign in** with a demo account:
   - `admin` / `admin123`
   - `finance` / `finance2026`

   These are demo credentials stored in the app. They are not real security.
2. **Upload** invoices: drag files onto the window, or click **Upload invoices**. Supported: PDF, PNG, JPG, JPEG, TIFF. Multiple files at once are fine.
3. **Review** the worksheet:
   - **Needs Review** rows have something to check. Hover the badge to see what.
   - **Yellow cells** have low OCR confidence or are missing.
   - Click any cell to edit it. Amounts and dates are tidied up automatically when you leave the cell.
   - Press `Enter` to move down a column.
   - The **eye** icon opens the invoice image, per-field confidence and the raw extracted text.
   - The **tick** icon marks a row as reviewed.
   - **Add row** adds an invoice by hand.
4. **Export**: **Export Excel** or **Export PDF** opens a Save dialog (Downloads by default). Only the current, edited values are exported.

The worksheet is saved automatically and comes back the next time you sign in.

### What gets extracted

| Field | How it is found |
|---|---|
| Vendor | `From:` / `Supplier:` labels, company names (Pte Ltd, Ltd, LLC, Sdn Bhd…) above "Bill To", or the top line |
| Invoice No. | `Invoice No / Number / # / Ref` labels, or `INV-…` patterns |
| Date | `Invoice Date / Date / Issue Date` (due dates are ignored), saved as DD/MM/YYYY |
| Amount | `Subtotal / Amount before GST / Net Amount` |
| GST | `GST / VAT / Tax` lines (not GST registration numbers) |
| Total | `Total Amount Due / Grand Total / Balance Due / Total` |
| Description | Line items under a `Description` heading, or `Re:` / `Subject:` |

The app checks that **Amount + GST = Total**. If one of the three is missing it is calculated from the other two and flagged for review. PDFs that contain real text (most invoices emailed as PDFs) are read exactly, without OCR. Scanned PDFs and images go through OCR.

Tips for best accuracy: use scans at 300 DPI or clear, flat photos; English documents only.

## For developers

```bash
npm install          # also copies OCR engine + English data into public/ocr
npm run dev          # browser preview at http://localhost:1420 (exports download as files)
npm test             # extraction unit tests
npx tauri dev        # desktop window (needs Rust)
npx tauri build      # release build -> src-tauri/target/release/evolve-ap-ocr.exe
```

Layout:

```
src/
  main.ts      UI: login, upload, worksheet, preview drawer, toasts
  ocr.ts       PDF text layer / pdf.js rendering, TIFF decode, Tesseract.js OCR
  parser.ts    field extraction + validation rules (pure, unit tested)
  review.ts    confidence and "Needs Review" logic
  export.ts    Excel (ExcelJS) and PDF (jsPDF + autotable) generation
  save.ts      native Save dialog (Tauri) with browser download fallback
  auth.ts      demo login
src-tauri/     Rust shell: window, Save dialog plugin, save_file / reveal_file commands
scripts/copy-ocr-assets.mjs   bundles the OCR engine so it works offline
.github/workflows/build.yml   builds the Windows exe and Mac dmg in the cloud
```
