const TOAST_DURATION_MS = 3200;

export function showToast(message: string): void {
  const existing = document.querySelector<HTMLElement>(".gdrive-toast");
  existing?.remove();
  const toast = document.createElement("div");
  toast.className = "gdrive-toast";
  toast.textContent = message;
  toast.setAttribute("role", "status");
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}
