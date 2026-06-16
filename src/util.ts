import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/** 是否在 Android WebView 中執行 */
export const isAndroid = /android/i.test(navigator.userAgent);

export interface CmdError {
  code: string;
  message: string;
}

export interface FileItem {
  name: string;
  path: string;
  size: number;
  ext: string;
}

export const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let toastTimer: number | null = null;

export function showToast(msg: string) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 3000);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + " GB";
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + " MB";
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(0) + " KB";
  return bytes + " B";
}

export function asCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as CmdError;
  return { code: "error", message: String(e) };
}

// ---------- 全螢幕（集中管理狀態，讓 Esc 行為一致） ----------
let fullscreen = false;

export async function toggleFullscreen() {
  fullscreen = !fullscreen;
  await getCurrentWindow().setFullscreen(fullscreen);
}

/** 若目前是全螢幕則退出並回傳 true（呼叫端據此決定 Esc 是否繼續處理） */
export async function exitFullscreenIfAny(): Promise<boolean> {
  if (!fullscreen) return false;
  fullscreen = false;
  await getCurrentWindow().setFullscreen(false);
  return true;
}

// ---------- 底部列自動隱藏（全 App 共用） ----------
/**
 * 讓某個底部列「捲動內容時收起、從螢幕底部邊緣上滑或點拉把時叫出」。
 * 不直接改樣式，而是呼叫 onShow/onHide（由呼叫端切換對應 class），
 * 以同時相容「固定覆蓋式」與「正常流收合式」兩種底部列。
 */
export function setupAutoHideBar(opts: {
  onShow: () => void;
  onHide: () => void;
  scrollEls: HTMLElement[];
  rootEl: HTMLElement;
  handleEl?: HTMLElement | null;
  isActive?: () => boolean;
}) {
  const { onShow, onHide, scrollEls, rootEl, handleEl, isActive } = opts;
  const active = () => (isActive ? isActive() : true);

  for (const el of scrollEls) {
    let prev = 0;
    el.addEventListener(
      "scroll",
      () => {
        if (!active()) return;
        const y = el.scrollTop;
        if (y > prev + 8) onHide(); // 下滑內容 → 收起
        prev = y < 0 ? 0 : y;
      },
      { passive: true }
    );
  }

  // 從螢幕底部邊緣上滑 → 叫出
  let tracking = false;
  let startY = 0;
  rootEl.addEventListener(
    "touchstart",
    (ev) => {
      if (!active()) return;
      const t = ev.touches[0];
      if (t && t.clientY >= window.innerHeight - 48) {
        tracking = true;
        startY = t.clientY;
      }
    },
    { passive: true }
  );
  rootEl.addEventListener(
    "touchmove",
    (ev) => {
      if (!tracking) return;
      const t = ev.touches[0];
      if (t && startY - t.clientY > 28) {
        onShow();
        tracking = false;
      }
    },
    { passive: true }
  );
  rootEl.addEventListener("touchend", () => {
    tracking = false;
  });

  handleEl?.addEventListener("click", onShow);
}

// ---------- Android 資料夾選擇（路徑輸入 + 常用位置） ----------
let folderResolve: ((path: string | null) => void) | null = null;

export function initAndroidFolderDialog() {
  const dialog = document.getElementById("folder-dialog") as HTMLDialogElement;
  const form = document.getElementById("folder-form") as HTMLFormElement;
  const input = document.getElementById("folder-input") as HTMLInputElement;

  document.querySelectorAll<HTMLButtonElement>("#folder-dialog .preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.path!;
    });
  });

  document.getElementById("folder-grant")!.addEventListener("click", async () => {
    await invoke("plugin:androidbridge|requestAllFilesAccess").catch(() => {});
  });

  // 原生資料夾選擇器（SAF），選完自動填入路徑
  document.getElementById("folder-browse")!.addEventListener("click", async () => {
    try {
      const res = await invoke<{ path?: string }>("plugin:androidbridge|pickFolder");
      if (res?.path) input.value = res.path;
    } catch (e) {
      showToast("無法開啟資料夾選擇器：" + String(e));
    }
  });

  document.getElementById("folder-cancel")!.addEventListener("click", () => {
    dialog.close();
    folderResolve?.(null);
    folderResolve = null;
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const path = input.value.trim();
    if (!path) return;
    dialog.close();
    // 沒有「所有檔案存取權」時順手帶使用者去授權頁
    try {
      const res = await invoke<{ granted: boolean }>("plugin:androidbridge|hasAllFilesAccess");
      if (!res.granted) {
        showToast("請先授予「所有檔案存取權」後再重新整理");
        await invoke("plugin:androidbridge|requestAllFilesAccess").catch(() => {});
      }
    } catch {
      // 桌面或外掛不可用時略過
    }
    folderResolve?.(path);
    folderResolve = null;
  });
}

/** Android 用：開啟路徑輸入對話框，回傳選擇的路徑（取消為 null） */
export function pickFolderAndroid(lastPath?: string | null): Promise<string | null> {
  const dialog = document.getElementById("folder-dialog") as HTMLDialogElement;
  const input = document.getElementById("folder-input") as HTMLInputElement;
  input.value = lastPath ?? "/storage/emulated/0/Download";
  return new Promise((resolve) => {
    folderResolve = resolve;
    dialog.showModal();
  });
}
