// Saving files: native "Save As" dialog inside the desktop app,
// browser download as a fallback when running in a normal browser (dev / tests).

export const isDesktop = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface SaveResult {
  path: string;
  desktop: boolean;
}

export async function saveBytes(
  bytes: Uint8Array,
  fileName: string,
  filter: { name: string; extensions: string[] },
): Promise<SaveResult | null> {
  if (isDesktop()) {
    const [{ save }, { downloadDir, join }, { invoke }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/api/path"),
      import("@tauri-apps/api/core"),
    ]);
    let defaultPath = fileName;
    try {
      defaultPath = await join(await downloadDir(), fileName);
    } catch {
      /* no Downloads folder - let the dialog decide */
    }
    const path = await save({ defaultPath, filters: [filter], title: "Save export" });
    if (!path) return null;
    await invoke("save_file", { path, data: Array.from(bytes) });
    return { path, desktop: true };
  }

  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { path: `Downloads/${fileName}`, desktop: false };
}

export async function revealFile(path: string): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_file", { path });
}
