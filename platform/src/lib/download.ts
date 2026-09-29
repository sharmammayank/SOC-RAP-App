/** File names limited to letters, digits, dot, underscore and hyphen. */
export const safeName = (s: string) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "report";

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = safeName(filename);
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
