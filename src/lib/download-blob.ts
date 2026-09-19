// A Blob handed to the browser as a download, by the `<a download>` route
// AvatarCropper's object URL already relies on. Client-only. The anchor is
// attached for the click — Firefox ignores a click on a detached anchor —
// and the URL is revoked a beat later, since revoking synchronously after
// the click races the navigation in some engines.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
