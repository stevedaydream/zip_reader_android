import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  $,
  showToast,
  formatSize,
  asCmdError,
  toggleFullscreen,
  exitFullscreenIfAny,
  isAndroid,
  initAndroidFolderDialog,
  pickFolderAndroid,
  type FileItem,
} from "./util";
import { initNovel, isNovelReaderOpen } from "./novel";
import { initSources } from "./sources";
import { initBrowse } from "./browse";

/** Android 更新檢查用：發佈此 app 的 GitHub 儲存庫（owner/repo） */
const GITHUB_REPO = "stevedaydream/zip_reader_android";

interface OpenResult {
  entries: string[];
  password: string | null;
}

interface PageData {
  data: string;
  mime: string;
}

// ---------- 元素 ----------
const appShell = $("app-shell");
const readerView = $("reader-view");
const folderPath = $("folder-path");
const archiveGrid = $("archive-grid");
const readerTitle = $("reader-title");
const pageIndicator = $("page-indicator");
const pageImage = $<HTMLImageElement>("page-image");
const pageContainer = $("page-container");
const pageLoading = $("page-loading");
const autoIntervalInput = $<HTMLInputElement>("auto-interval");
const btnAutoplay = $<HTMLButtonElement>("btn-autoplay");
const btnFit = $<HTMLButtonElement>("btn-fit");
const passwordDialog = $<HTMLDialogElement>("password-dialog");
const passwordInput = $<HTMLInputElement>("password-input");
const passwordSave = $<HTMLInputElement>("password-save");
const passwordError = $("password-error");
const passwordArchiveName = $("password-archive-name");
const pwmgrDialog = $<HTMLDialogElement>("pwmgr-dialog");
const pwmgrList = $("pwmgr-list");
const pwmgrInput = $<HTMLInputElement>("pwmgr-input");

// ---------- 分頁切換 ----------
const tabViews: Record<string, HTMLElement> = {
  comic: $("library-view"),
  novel: $("novel-view"),
  sources: $("sources-view"),
};

function switchTab(name: string) {
  for (const [key, view] of Object.entries(tabViews)) {
    view.classList.toggle("hidden", key !== name);
  }
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  localStorage.setItem("activeTab", name);
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab!));
});

// ---------- 漫畫書庫狀態 ----------
let currentFolder: string | null = localStorage.getItem("lastFolder");
let currentArchive: {
  path: string;
  name: string;
  entries: string[];
  password: string | null;
} | null = null;
let pageIndex = 0;
let autoplayTimer: number | null = null;
let fitWidth = localStorage.getItem("fitWidth") === "1";
const pageCache = new Map<number, string>();

// ---------- 漫畫書庫 ----------
async function pickFolder() {
  let dir: string | null = null;
  if (isAndroid) {
    dir = await pickFolderAndroid(currentFolder);
  } else {
    const picked = await openDialog({ directory: true, title: "選擇漫畫資料夾" });
    if (typeof picked === "string") dir = picked;
  }
  if (dir) {
    currentFolder = dir;
    localStorage.setItem("lastFolder", dir);
    await loadLibrary();
  }
}

async function loadLibrary() {
  if (!currentFolder) return;
  folderPath.textContent = currentFolder;
  try {
    const items = await invoke<FileItem[]>("list_archives", { dir: currentFolder });
    renderLibrary(items);
  } catch (e) {
    showToast("讀取資料夾失敗：" + asCmdError(e).message);
  }
}

function renderLibrary(items: FileItem[]) {
  archiveGrid.innerHTML = "";
  if (items.length === 0) {
    archiveGrid.innerHTML = '<p class="empty-hint">此資料夾沒有支援的壓縮檔</p>';
    return;
  }
  items.forEach((item, idx) => {
    const card = document.createElement("button");
    card.className = "archive-card";
    card.style.setProperty("--i", String(idx));
    card.innerHTML = `
      <span class="cover">
        <span class="badge"></span>
        <span class="archive-name"></span>
      </span>
      <span class="archive-meta"><span class="size"></span></span>`;
    card.querySelector(".archive-name")!.textContent = item.name;
    card.querySelector(".badge")!.textContent = item.ext.toUpperCase();
    card.querySelector(".size")!.textContent = formatSize(item.size);
    card.addEventListener("click", () => openArchive(item));
    archiveGrid.appendChild(card);
  });
}

// ---------- 開啟壓縮檔（含密碼流程） ----------
async function openArchive(item: FileItem, password?: string): Promise<boolean> {
  pageLoading.classList.remove("hidden");
  try {
    const result = await invoke<OpenResult>("open_archive", {
      path: item.path,
      password: password ?? null,
    });
    currentArchive = {
      path: item.path,
      name: item.name,
      entries: result.entries,
      password: result.password,
    };
    pageCache.clear();
    pageIndex = 0;
    enterReader();
    return true;
  } catch (e) {
    const err = asCmdError(e);
    if (err.code === "need_password") {
      promptPassword(item, password !== undefined);
    } else {
      showToast("開啟失敗：" + err.message);
    }
    return false;
  } finally {
    pageLoading.classList.add("hidden");
  }
}

function promptPassword(item: FileItem, wasWrong: boolean) {
  passwordArchiveName.textContent = item.name;
  passwordError.classList.toggle("hidden", !wasWrong);
  passwordInput.value = "";
  passwordDialog.showModal();
  passwordInput.focus();

  const form = $<HTMLFormElement>("password-form");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const pw = passwordInput.value;
    if (!pw) return;
    passwordDialog.close();
    const ok = await openArchive(item, pw);
    if (ok && passwordSave.checked) {
      await invoke("add_password", { password: pw }).catch(() => {});
    }
  };
  $("password-cancel").onclick = () => passwordDialog.close();
}

// ---------- 漫畫閱讀器 ----------
function enterReader() {
  appShell.classList.add("hidden");
  readerView.classList.remove("hidden");
  readerTitle.textContent = currentArchive!.name;
  applyFitMode();
  void showPage(0);
}

function exitReader() {
  stopAutoplay();
  readerView.classList.add("hidden");
  appShell.classList.remove("hidden");
  pageImage.src = "";
  currentArchive = null;
  pageCache.clear();
}

async function fetchPage(index: number): Promise<string> {
  const cached = pageCache.get(index);
  if (cached) return cached;
  const arc = currentArchive!;
  const page = await invoke<PageData>("get_page", {
    path: arc.path,
    entry: arc.entries[index],
    password: arc.password,
  });
  const url = `data:${page.mime};base64,${page.data}`;
  pageCache.set(index, url);
  // 快取上限，避免吃光記憶體
  if (pageCache.size > 8) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined && oldest !== index) pageCache.delete(oldest);
  }
  return url;
}

async function showPage(index: number) {
  const arc = currentArchive;
  if (!arc) return;
  if (index < 0 || index >= arc.entries.length) return;
  pageIndex = index;
  pageIndicator.textContent = `${index + 1} / ${arc.entries.length}`;
  pageLoading.classList.remove("hidden");
  try {
    const url = await fetchPage(index);
    if (pageImage.src !== url) {
      pageImage.classList.remove("loaded");
      pageImage.src = url;
    }
    pageContainer.scrollTop = 0;
  } catch (e) {
    showToast("載入頁面失敗：" + asCmdError(e).message);
  } finally {
    pageLoading.classList.add("hidden");
  }
  // 預載下一頁
  if (index + 1 < arc.entries.length) {
    fetchPage(index + 1).catch(() => {});
  }
}

function nextPage() {
  if (!currentArchive) return;
  if (pageIndex + 1 >= currentArchive.entries.length) {
    stopAutoplay();
    showToast("已是最後一頁");
    return;
  }
  void showPage(pageIndex + 1);
}

function prevPage() {
  void showPage(pageIndex - 1);
}

// ---------- 自動翻頁 ----------
function startAutoplay() {
  const seconds = Math.max(0.5, parseFloat(autoIntervalInput.value) || 3);
  autoIntervalInput.value = String(seconds);
  localStorage.setItem("autoInterval", String(seconds));
  stopAutoplay();
  autoplayTimer = window.setInterval(nextPage, seconds * 1000);
  btnAutoplay.textContent = "停止翻頁";
  btnAutoplay.classList.add("active");
}

function stopAutoplay() {
  if (autoplayTimer !== null) {
    clearInterval(autoplayTimer);
    autoplayTimer = null;
  }
  btnAutoplay.textContent = "自動翻頁";
  btnAutoplay.classList.remove("active");
}

function toggleAutoplay() {
  if (autoplayTimer !== null) stopAutoplay();
  else startAutoplay();
}

// ---------- 顯示模式 ----------
function applyFitMode() {
  pageContainer.classList.toggle("fit-width", fitWidth);
  btnFit.textContent = fitWidth ? "適應寬度" : "適應高度";
}

function toggleFit() {
  fitWidth = !fitWidth;
  localStorage.setItem("fitWidth", fitWidth ? "1" : "0");
  applyFitMode();
}

// ---------- 密碼管理 ----------
async function renderPasswordList() {
  const list = await invoke<string[]>("get_passwords");
  pwmgrList.innerHTML = "";
  if (list.length === 0) {
    pwmgrList.innerHTML = '<li class="pw-empty">（尚無已儲存的密碼）</li>';
    return;
  }
  for (const pw of list) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = pw;
    const del = document.createElement("button");
    del.textContent = "刪除";
    del.className = "danger";
    del.addEventListener("click", async () => {
      await invoke("remove_password", { password: pw });
      await renderPasswordList();
    });
    li.append(span, del);
    pwmgrList.appendChild(li);
  }
}

// ---------- 自動更新 ----------
function newerVersion(remote: string, local: string): boolean {
  const pa = remote.replace(/^v/i, "").split(".").map(Number);
  const pb = local.replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0;
    const b = pb[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** Android：updater 外掛不支援，改查 GitHub Releases API 並引導下載 APK */
async function checkUpdateAndroid(silent: boolean) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = (await res.json()) as { tag_name: string; html_url: string };
  const current = await getVersion();
  if (newerVersion(release.tag_name, current)) {
    const yes = await ask(
      `發現新版本 ${release.tag_name}（目前 v${current}），是否前往下載 APK？`,
      { title: "軟體更新" }
    );
    if (yes) await openUrl(release.html_url);
  } else if (!silent) {
    showToast("目前已是最新版本");
  }
}

async function doCheckUpdate(silent: boolean) {
  try {
    if (isAndroid) {
      await checkUpdateAndroid(silent);
      return;
    }
    const update = await checkUpdate();
    if (update) {
      const yes = await ask(`發現新版本 ${update.version}，是否立即下載並更新？`, {
        title: "軟體更新",
      });
      if (yes) {
        showToast("正在下載更新…");
        await update.downloadAndInstall();
        await relaunch();
      }
    } else if (!silent) {
      showToast("目前已是最新版本");
    }
  } catch (e) {
    if (!silent) showToast("檢查更新失敗：" + String(e));
  }
}

// ---------- 事件繫結 ----------
pageImage.addEventListener("load", () => pageImage.classList.add("loaded"));
$("btn-pick-folder").addEventListener("click", pickFolder);
$("btn-refresh").addEventListener("click", loadLibrary);
$("btn-back").addEventListener("click", exitReader);
$("zone-next").addEventListener("click", nextPage);
$("zone-prev").addEventListener("click", prevPage);
btnAutoplay.addEventListener("click", toggleAutoplay);
btnFit.addEventListener("click", toggleFit);
$("btn-fullscreen").addEventListener("click", toggleFullscreen);
$("btn-fullscreen-app").addEventListener("click", toggleFullscreen);
$("btn-fullscreen-novel").addEventListener("click", toggleFullscreen);
$("btn-check-update").addEventListener("click", () => doCheckUpdate(false));
$("btn-passwords").addEventListener("click", async () => {
  await renderPasswordList();
  pwmgrDialog.showModal();
});
$("pwmgr-close").addEventListener("click", () => pwmgrDialog.close());
$<HTMLFormElement>("pwmgr-add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pw = pwmgrInput.value.trim();
  if (!pw) return;
  await invoke("add_password", { password: pw });
  pwmgrInput.value = "";
  await renderPasswordList();
});

// 觸控滑動翻頁（左滑下一頁、右滑上一頁）
let touchStartX = 0;
let touchStartY = 0;
pageContainer.addEventListener(
  "touchstart",
  (ev) => {
    touchStartX = ev.touches[0].clientX;
    touchStartY = ev.touches[0].clientY;
  },
  { passive: true }
);
pageContainer.addEventListener(
  "touchend",
  (ev) => {
    const dx = ev.changedTouches[0].clientX - touchStartX;
    const dy = ev.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) nextPage();
      else prevPage();
    }
  },
  { passive: true }
);

// 自動翻頁間隔變更時即時生效
autoIntervalInput.addEventListener("change", () => {
  localStorage.setItem("autoInterval", autoIntervalInput.value);
  if (autoplayTimer !== null) startAutoplay();
});

// 鍵盤操作
document.addEventListener("keydown", async (ev) => {
  // F11 全域切換全螢幕
  if (ev.key === "F11") {
    ev.preventDefault();
    await toggleFullscreen();
    return;
  }
  // 主畫面 Esc：退出全螢幕
  if (ev.key === "Escape" && !appShell.classList.contains("hidden")) {
    await exitFullscreenIfAny();
    return;
  }
  // 以下為漫畫閱讀器快捷鍵
  if (readerView.classList.contains("hidden")) return;
  if (passwordDialog.open || pwmgrDialog.open) return;
  if (isNovelReaderOpen()) return;
  switch (ev.key) {
    case "ArrowRight":
    case " ":
      ev.preventDefault();
      nextPage();
      break;
    case "ArrowLeft":
      ev.preventDefault();
      prevPage();
      break;
    case "Escape":
      // 全螢幕中先退出全螢幕，再按一次才返回書庫
      if (await exitFullscreenIfAny()) return;
      exitReader();
      break;
    case "Home":
      void showPage(0);
      break;
    case "End":
      void showPage((currentArchive?.entries.length ?? 1) - 1);
      break;
  }
});

// ---------- 啟動 ----------
if (isAndroid) document.body.classList.add("android");
initAndroidFolderDialog();
const savedInterval = localStorage.getItem("autoInterval");
if (savedInterval) autoIntervalInput.value = savedInterval;
switchTab(localStorage.getItem("activeTab") ?? "comic");
if (currentFolder) void loadLibrary();
initNovel(appShell);
initSources();
initBrowse(appShell);
void doCheckUpdate(true);
