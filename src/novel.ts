import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  $,
  showToast,
  formatSize,
  asCmdError,
  exitFullscreenIfAny,
  isAndroid,
  pickFolderAndroid,
  setupAutoHideBar,
  type FileItem,
} from "./util";
import { openBrowse } from "./browse";

// ---------- 元素 ----------
const novelFolderPath = $("novel-folder-path");
const novelGrid = $("novel-grid");
const novelReaderView = $("novel-reader-view");
const novelTitle = $("novel-title");
const novelScroll = $("novel-scroll");
const novelContent = $("novel-content");
const ttsVoiceSelect = $<HTMLSelectElement>("tts-voice");
const ttsRateInput = $<HTMLInputElement>("tts-rate");
const ttsRateValue = $("tts-rate-value");
const btnTtsPlay = $<HTMLButtonElement>("btn-tts-play");
const btnTtsPause = $<HTMLButtonElement>("btn-tts-pause");

interface WebChapter {
  title: string;
  text: string;
  next_url: string | null;
  prev_url: string | null;
}

interface WebNovel {
  name: string;
  url: string;
}

interface SourceChapter {
  title: string;
  url: string;
}
interface SourceBookDetail {
  name: string;
  chapters: SourceChapter[];
}

interface CachedChapter {
  url: string;
  title: string;
  text: string;
  next_url: string | null;
  prev_url: string | null;
  fetched_at: number;
}
interface PreloadBook {
  book_url: string;
  name: string;
  author: string;
  chapter_count: number;
  total_bytes: number;
  oldest: number;
  newest: number;
}

// ---------- 狀態 ----------
let novelFolder: string | null = localStorage.getItem("novelFolder");
let fontSize = parseInt(localStorage.getItem("novelFontSize") ?? "19", 10);
let paragraphs: HTMLParagraphElement[] = [];
let ttsPos = 0;
let ttsActive = false;
let ttsPaused = false;
let voices: SpeechSynthesisVoice[] = [];
let appShell: HTMLElement;

// 網路小說模式狀態
let webMode = false;
let webBookName: string | null = null;
let webNextUrl: string | null = null;
let webPrevUrl: string | null = null;
let webLoading = false;
// 書源（黃金屋）閱讀時的書籍上下文，供「我的最愛」記錄續讀位置
let bookCtx: { name: string; author: string; bookUrl: string } | null = null;
// 是否從書源瀏覽器進入閱讀（返回時回到書源而非書庫）
let fromBrowse = false;
// 書源模式（黃金屋）：閱讀頁改用底部自動隱藏導覽列＋目錄
let sourceMode = false;
let webCurrentUrl: string | null = null;
let tocLoading = false;
let preloading = false;
let preloadCancel = false;

export function isNovelReaderOpen(): boolean {
  return !novelReaderView.classList.contains("hidden");
}

// ---------- 書庫 ----------
async function pickNovelFolder() {
  let dir: string | null = null;
  if (isAndroid) {
    dir = await pickFolderAndroid(novelFolder);
  } else {
    const picked = await openDialog({ directory: true, title: "選擇小說資料夾" });
    if (typeof picked === "string") dir = picked;
  }
  if (dir) {
    novelFolder = dir;
    localStorage.setItem("novelFolder", dir);
    await loadNovels();
  }
}

async function loadNovels() {
  if (!novelFolder) return;
  novelFolderPath.textContent = novelFolder;
  try {
    const items = await invoke<FileItem[]>("list_novels", { dir: novelFolder });
    renderNovels(items);
  } catch (e) {
    showToast("讀取資料夾失敗：" + asCmdError(e).message);
  }
}

const EXT_RE = /\.(txt|epub|mobi|azw3?|azw)$/i;

function renderNovels(items: FileItem[]) {
  novelGrid.innerHTML = "";
  if (items.length === 0) {
    novelGrid.innerHTML = '<p class="empty-hint">此資料夾沒有支援的電子書檔（TXT・EPUB・MOBI・AZW3）</p>';
    return;
  }
  items.forEach((item, idx) => {
    const card = document.createElement("button");
    card.className = "archive-card";
    card.style.setProperty("--i", String(idx));
    card.innerHTML = `
      <span class="cover novel-cover">
        <span class="badge"></span>
        <span class="archive-name"></span>
      </span>
      <span class="archive-meta"><span class="size"></span></span>`;
    card.querySelector(".archive-name")!.textContent = item.name.replace(EXT_RE, "");
    card.querySelector(".badge")!.textContent = item.ext.toUpperCase();
    card.querySelector(".size")!.textContent = formatSize(item.size);
    card.addEventListener("click", () => openNovel(item));
    novelGrid.appendChild(card);
  });
}

// ---------- 閱讀（本地與網路共用渲染） ----------
function renderNovelText(title: string, text: string) {
  novelTitle.textContent = title;
  novelContent.innerHTML = "";
  paragraphs = [];
  const frag = document.createDocumentFragment();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = document.createElement("p");
    p.textContent = line;
    const idx = paragraphs.length;
    p.addEventListener("click", () => speakFrom(idx));
    paragraphs.push(p);
    frag.appendChild(p);
  }
  novelContent.appendChild(frag);
  applyFontSize();
  appShell.classList.add("hidden");
  document.getElementById("browse-view")!.classList.add("hidden");
  novelReaderView.classList.remove("hidden");
  novelReaderView.classList.toggle("source-mode", sourceMode);
  novelScroll.scrollTop = 0;
  ttsPos = 0;
  showBottomBar(); // 進入新內容時先顯示底部列（兩種模式皆然）
}

async function openNovel(item: FileItem) {
  let text: string;
  try {
    text = await invoke<string>("read_text_file", { path: item.path });
  } catch (e) {
    showToast("開啟失敗：" + asCmdError(e).message);
    return;
  }
  webMode = false;
  sourceMode = false;
  bookCtx = null;
  updateChapterNav();
  renderNovelText(item.name.replace(EXT_RE, ""), text);
}

export function closeNovelReader() {
  stopTts();
  closeToc();
  closeSettings();
  novelReaderView.classList.add("hidden");
  novelReaderView.classList.remove("source-mode");
  hideBottomBar();
  novelContent.innerHTML = "";
  paragraphs = [];
  webMode = false;
  sourceMode = false;
  if (fromBrowse) {
    // 從書源進來 → 返回書源瀏覽器（首頁會反映最新續讀進度）
    fromBrowse = false;
    void openBrowse();
  } else {
    appShell.classList.remove("hidden");
    void renderWebShelf(); // 返回書庫時刷新書架（最後閱讀章節可能已更新）
  }
}

// ---------- 網路小說 ----------
function updateChapterNav() {
  $("btn-prev-chapter").classList.toggle("hidden", !webMode || !webPrevUrl);
  $("btn-next-chapter").classList.toggle("hidden", !webMode || !webNextUrl);
  $("btn-next-bottom").classList.toggle("hidden", !webMode || !webNextUrl);
  $<HTMLButtonElement>("nr-prev").disabled = !webPrevUrl;
  $<HTMLButtonElement>("nr-next").disabled = !webNextUrl;
}

/** 開啟網路小說章節；bookName 為書架名（首次開啟用章節標題建檔） */
async function openWebChapter(url: string, bookName?: string | null): Promise<boolean> {
  if (webLoading) return false;
  webLoading = true;
  showToast("正在載入章節…");
  try {
    // 書源閱讀：先查離線快取，命中即離線讀取（搭機適用）
    let ch: WebChapter;
    const cached = bookCtx
      ? await invoke<CachedChapter | null>("preload_get_chapter", {
          bookUrl: bookCtx.bookUrl,
          url,
        }).catch(() => null)
      : null;
    if (cached) {
      ch = { title: cached.title, text: cached.text, next_url: cached.next_url, prev_url: cached.prev_url };
    } else {
      ch = await invoke<WebChapter>("fetch_web_chapter", { url });
    }
    // 僅中止當前朗讀（flush），不結束會話——換章時前景服務須持續存活，
    // 否則 speakFrom 會嘗試在背景重啟前景服務而被系統拒絕（換章後不發聲）。
    cancelSpeech();
    webMode = true;
    webCurrentUrl = url;
    webNextUrl = ch.next_url;
    webPrevUrl = ch.prev_url;
    webBookName = bookName ?? webBookName ?? ch.title ?? url;
    renderNovelText(ch.title || webBookName, ch.text);
    updateChapterNav();
    if (bookCtx) {
      // 書源閱讀：更新「我的最愛」續讀位置（書不在最愛則後端略過）
      await invoke("update_favorite_progress", {
        bookUrl: bookCtx.bookUrl,
        chapterUrl: url,
        chapterTitle: ch.title || "",
      }).catch(() => {});
    } else {
      // 一般貼網址閱讀：記到網路書架
      await invoke("upsert_webnovel", { name: webBookName, url }).catch(() => {});
    }
    return true;
  } catch (e) {
    showToast("載入失敗：" + asCmdError(e).message);
    return false;
  } finally {
    webLoading = false;
  }
}

/**
 * 從書源開啟章節並進入閱讀（供書源瀏覽器呼叫）。
 * ctx 提供書籍資訊，閱讀時自動更新最愛續讀進度。
 */
export async function openSourceChapter(
  url: string,
  ctx: { name: string; author: string; bookUrl: string }
): Promise<void> {
  bookCtx = ctx;
  fromBrowse = true;
  sourceMode = true;
  webBookName = ctx.name;
  await openWebChapter(url, ctx.name);
}

// ---------- 底部導覽列（書源精簡列 / 非書源 paper-bar 共用顯隱） ----------
function showBottomBar() {
  novelReaderView.classList.remove("chrome-hidden");
}
function hideBottomBar() {
  novelReaderView.classList.add("chrome-hidden");
}

/** 單一朗讀切換鈕：朗讀中→停止，否則從目前段落開始 */
function toggleTts() {
  if (ttsActive) stopTts();
  else speakFrom(ttsPos || 0);
}

// ---------- 閱讀設定面板（語速 / 字體） ----------
function openSettings() {
  // 同步目前狀態到面板
  $<HTMLInputElement>("nr-rate").value = ttsRateInput.value;
  $("nr-rate-value").textContent = currentRate().toFixed(1);
  $("nr-font-value").textContent = String(fontSize);
  $("nr-set-backdrop").classList.remove("hidden");
  $("nr-set-panel").classList.remove("hidden");
}
function closeSettings() {
  $("nr-set-panel").classList.add("hidden");
  $("nr-set-backdrop").classList.add("hidden");
}

// ---------- 章節目錄面板 ----------
function closeToc() {
  $("nr-toc-panel").classList.add("hidden");
  $("nr-toc-backdrop").classList.add("hidden");
}

async function openToc() {
  if (!bookCtx || tocLoading) return;
  tocLoading = true;
  const listEl = $("nr-toc-list");
  const titleEl = $("nr-toc-title");
  titleEl.textContent = bookCtx.name || "目錄";
  listEl.innerHTML = `<p class="browse-loading">載入目錄中…</p>`;
  $("nr-toc-backdrop").classList.remove("hidden");
  $("nr-toc-panel").classList.remove("hidden");
  try {
    // 先連網取最新目錄並順手快取；連不上則退回離線快取目錄
    let d: SourceBookDetail;
    let offline = false;
    try {
      d = await invoke<SourceBookDetail>("hjwzw_book_detail", { url: bookCtx.bookUrl });
      void invoke("preload_cache_book_detail", {
        bookUrl: bookCtx.bookUrl,
        name: bookCtx.name,
        author: bookCtx.author,
        toc: d.chapters,
      }).catch(() => {});
    } catch (netErr) {
      const cachedDetail = await invoke<SourceBookDetail | null>("preload_get_book_detail", {
        bookUrl: bookCtx.bookUrl,
      }).catch(() => null);
      if (!cachedDetail) throw netErr;
      d = cachedDetail;
      offline = true;
    }
    const cachedCount = (await invoke<PreloadBook[]>("preload_list").catch(() => []))
      .find((b) => b.book_url === bookCtx!.bookUrl)?.chapter_count;
    const suffix = offline ? "（離線目錄）" : cachedCount ? `（已離線 ${cachedCount} 章）` : "";
    titleEl.textContent = `${d.name}（共 ${d.chapters.length} 章）${suffix}`;
    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    let currentItem: HTMLElement | null = null;
    for (const ch of d.chapters) {
      const item = document.createElement("button");
      item.className = "toc-item";
      item.textContent = ch.title;
      if (ch.url === webCurrentUrl) {
        item.classList.add("current");
        currentItem = item;
      }
      item.addEventListener("click", () => {
        closeToc();
        const wasReading = ttsActive && !ttsPaused;
        void openWebChapter(ch.url).then((ok) => {
          if (ok && wasReading) speakFrom(0);
        });
      });
      frag.appendChild(item);
    }
    listEl.appendChild(frag);
    currentItem?.scrollIntoView({ block: "center" });
  } catch (e) {
    listEl.innerHTML = `<p class="browse-loading">載入失敗：${asCmdError(e).message}</p>`;
  } finally {
    tocLoading = false;
  }
}

async function gotoChapter(url: string | null) {
  if (!url) return;
  const wasReading = ttsActive && !ttsPaused;
  const ok = await openWebChapter(url);
  if (ok && wasReading) speakFrom(0);
}

// ---------- 離線預載 ----------
function fmtDate(secs: number): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 預載目前書「往後 count 章」的內文到本地（供離線閱讀） */
async function runPreload(count: number) {
  if (!bookCtx) {
    showToast("僅書源閱讀可預載");
    return;
  }
  if (preloading || !Number.isFinite(count) || count < 1) return;
  preloading = true;
  preloadCancel = false;
  const statusEl = $("nr-pre-status");
  const textEl = $("nr-pre-text");
  statusEl.classList.remove("hidden");
  textEl.textContent = "讀取目錄…";
  try {
    let chapters: SourceChapter[] = [];
    try {
      const d = await invoke<SourceBookDetail>("hjwzw_book_detail", { url: bookCtx.bookUrl });
      chapters = d.chapters;
      await invoke("preload_cache_book_detail", {
        bookUrl: bookCtx.bookUrl,
        name: bookCtx.name,
        author: bookCtx.author,
        toc: chapters,
      }).catch(() => {});
    } catch {
      const cd = await invoke<SourceBookDetail | null>("preload_get_book_detail", {
        bookUrl: bookCtx.bookUrl,
      }).catch(() => null);
      if (cd) chapters = cd.chapters;
    }
    if (chapters.length === 0) {
      showToast("無法取得目錄，預載中止");
      return;
    }
    let start = chapters.findIndex((c) => c.url === webCurrentUrl);
    if (start < 0) start = 0;
    const slice = chapters.slice(start, start + count);
    let done = 0;
    let added = 0;
    for (const ch of slice) {
      if (preloadCancel) break;
      done++;
      textEl.textContent = `預載中… ${done}/${slice.length}`;
      const has = await invoke<boolean>("preload_is_cached", {
        bookUrl: bookCtx.bookUrl,
        url: ch.url,
      }).catch(() => false);
      if (has) continue;
      try {
        const wc = await invoke<WebChapter>("fetch_web_chapter", { url: ch.url });
        await invoke("preload_cache_chapter", {
          bookUrl: bookCtx.bookUrl,
          name: bookCtx.name,
          author: bookCtx.author,
          url: ch.url,
          title: wc.title,
          text: wc.text,
          nextUrl: wc.next_url,
          prevUrl: wc.prev_url,
        });
        added++;
        await new Promise((r) => setTimeout(r, 350)); // 禮貌延遲，避免被黃金屋擋
      } catch {
        // 單章失敗略過，繼續下一章
      }
    }
    const msg = preloadCancel
      ? `已取消，新增 ${added} 章`
      : `預載完成：新增 ${added} 章（共 ${slice.length}）`;
    textEl.textContent = msg;
    showToast(msg);
  } finally {
    preloading = false;
    window.setTimeout(() => $("nr-pre-status").classList.add("hidden"), 5000);
  }
}

// ---------- 離線預載管理（小說分頁） ----------
async function openPreloadManager() {
  const dlg = $<HTMLDialogElement>("preload-dialog");
  const s = await invoke<{ retain_days: number }>("preload_get_settings").catch(() => ({
    retain_days: 7,
  }));
  $<HTMLInputElement>("pre-retain").value = String(s.retain_days);
  await renderPreloadList();
  dlg.showModal();
}

async function renderPreloadList() {
  const list = await invoke<PreloadBook[]>("preload_list").catch(() => [] as PreloadBook[]);
  const ul = $("pre-book-list");
  ul.innerHTML = "";
  if (list.length === 0) {
    ul.innerHTML = '<li class="pw-empty">（尚無離線預載）</li>';
    return;
  }
  for (const b of list) {
    const li = document.createElement("li");
    li.className = "pre-book";
    const info = document.createElement("div");
    info.className = "pre-book-info";
    const name = document.createElement("span");
    name.className = "pre-book-name";
    name.textContent = b.name || b.book_url;
    const meta = document.createElement("span");
    meta.className = "pre-book-meta";
    meta.textContent = `${b.chapter_count} 章 · ${formatSize(b.total_bytes)} · 更新 ${fmtDate(b.newest)}`;
    info.append(name, meta);
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "刪除";
    del.addEventListener("click", async () => {
      await invoke("preload_delete", { bookUrl: b.book_url }).catch(() => {});
      await renderPreloadList();
    });
    li.append(info, del);
    ul.appendChild(li);
  }
}

async function renderWebShelf() {
  const shelf = $("webnovel-shelf");
  const wrap = $("webnovel-shelf-wrap");
  const list = await invoke<WebNovel[]>("get_webnovels").catch(() => [] as WebNovel[]);
  wrap.classList.toggle("hidden", list.length === 0);
  shelf.innerHTML = "";
  list.forEach((item, idx) => {
    const card = document.createElement("button");
    card.className = "source-card";
    card.style.setProperty("--i", String(idx));
    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = item.name;
    const url = document.createElement("span");
    url.className = "source-url";
    url.textContent = item.url;
    const del = document.createElement("span");
    del.className = "source-del";
    del.textContent = "移除";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await invoke("remove_webnovel", { name: item.name }).catch(() => {});
      await renderWebShelf();
    });
    card.append(name, url, del);
    card.addEventListener("click", () => {
      sourceMode = false; // 網路書架非黃金屋書源，沿用頂部工具列
      bookCtx = null;
      void openWebChapter(item.url, item.name);
    });
    shelf.appendChild(card);
  });
}

function applyFontSize() {
  novelContent.style.fontSize = fontSize + "px";
  localStorage.setItem("novelFontSize", String(fontSize));
  const fv = document.getElementById("nr-font-value");
  if (fv) fv.textContent = String(fontSize);
}

// ---------- 朗讀（Web Speech API，使用系統本地語音） ----------
function loadVoices() {
  voices = window.speechSynthesis.getVoices();
  ttsVoiceSelect.innerHTML = "";
  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "（無可用語音）";
    ttsVoiceSelect.appendChild(opt);
    return;
  }
  // 中文語音排前面
  const sorted = [...voices].sort((a, b) => {
    const az = a.lang.startsWith("zh") ? 0 : 1;
    const bz = b.lang.startsWith("zh") ? 0 : 1;
    return az - bz || a.name.localeCompare(b.name);
  });
  const savedVoice = localStorage.getItem("ttsVoice");
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name}（${v.lang}）`;
    if (v.name === savedVoice) opt.selected = true;
    ttsVoiceSelect.appendChild(opt);
  }
}

function currentRate(): number {
  return Math.min(2, Math.max(0.5, parseFloat(ttsRateInput.value) || 1));
}

function clearHighlight() {
  novelContent.querySelector("p.speaking")?.classList.remove("speaking");
}

function speakCurrent() {
  if (!ttsActive) {
    stopTts();
    return;
  }
  if (ttsPos >= paragraphs.length) {
    // 網路小說：唸完整章自動載入下一章接著唸
    if (webMode && webNextUrl) {
      void gotoChapter(webNextUrl);
    } else {
      stopTts();
    }
    return;
  }
  const p = paragraphs[ttsPos];
  clearHighlight();
  p.classList.add("speaking");
  p.scrollIntoView({ block: "center", behavior: "smooth" });
  const text = p.textContent ?? "";

  if (isAndroid) {
    // 原生 TextToSpeech：唸完由外掛 "done" 事件推進下一段
    invoke("plugin:androidbridge|speak", { text, rate: currentRate() }).catch((e) => {
      showToast("朗讀失敗：" + String(e));
      stopTts();
    });
    return;
  }

  const u = new SpeechSynthesisUtterance(text);
  u.rate = currentRate();
  const voice = voices.find((v) => v.name === ttsVoiceSelect.value);
  if (voice) u.voice = voice;
  u.onend = () => {
    if (!ttsActive) return;
    ttsPos++;
    speakCurrent();
  };
  u.onerror = () => {
    if (ttsActive) stopTts();
  };
  window.speechSynthesis.speak(u);
}

function cancelSpeech() {
  if (isAndroid) {
    invoke("plugin:androidbridge|stopSpeak").catch(() => {});
  } else {
    window.speechSynthesis.cancel();
  }
}

function speakFrom(index: number) {
  ttsActive = false; // 先壓住 cancel 觸發的 onend/onerror
  cancelSpeech();
  ttsPos = index;
  ttsActive = true;
  ttsPaused = false;
  btnTtsPlay.classList.add("active");
  btnTtsPause.textContent = "暫停";
  setTtsToggle(true);
  speakCurrent();
}

/** 同步書源底部列的朗讀切換鈕外觀 */
function setTtsToggle(active: boolean) {
  const btn = $("nr-tts");
  btn.classList.toggle("active", active);
  btn.textContent = active ? "停止" : "朗讀";
}

function pauseOrResumeTts() {
  if (!ttsActive) return;
  if (ttsPaused) {
    ttsPaused = false;
    btnTtsPause.textContent = "暫停";
    if (isAndroid) {
      // 原生 TTS 沒有 resume，從目前段落重唸
      speakCurrent();
    } else {
      window.speechSynthesis.resume();
    }
  } else {
    ttsPaused = true;
    btnTtsPause.textContent = "繼續";
    if (isAndroid) {
      invoke("plugin:androidbridge|stopSpeak").catch(() => {});
    } else {
      window.speechSynthesis.pause();
    }
  }
}

function stopTts() {
  ttsActive = false;
  ttsPaused = false;
  if (isAndroid) {
    // 結束整個朗讀會話：釋放前景服務與 wake lock
    invoke("plugin:androidbridge|endTts").catch(() => {});
  } else {
    window.speechSynthesis.cancel();
  }
  clearHighlight();
  btnTtsPlay.classList.remove("active");
  btnTtsPause.textContent = "暫停";
  setTtsToggle(false);
}

// ---------- 初始化 ----------
export function initNovel(shell: HTMLElement) {
  appShell = shell;

  $("btn-pick-novel-folder").addEventListener("click", pickNovelFolder);
  $("btn-refresh-novels").addEventListener("click", loadNovels);
  $("novel-back").addEventListener("click", closeNovelReader);

  // 網路小說
  const webnovelUrl = $<HTMLInputElement>("webnovel-url");
  const startWebNovel = () => {
    let url = webnovelUrl.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    webBookName = null; // 新書以章節標題建檔
    bookCtx = null; // 貼網址流程非書源
    sourceMode = false; // 沿用頂部工具列
    void openWebChapter(url).then((ok) => {
      if (ok) webnovelUrl.value = "";
    });
  };
  $("webnovel-go").addEventListener("click", startWebNovel);
  webnovelUrl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") startWebNovel();
  });
  $("btn-open-browse").addEventListener("click", () => void openBrowse());
  $("btn-prev-chapter").addEventListener("click", () => void gotoChapter(webPrevUrl));
  $("btn-next-chapter").addEventListener("click", () => void gotoChapter(webNextUrl));
  $("btn-next-bottom").addEventListener("click", () => void gotoChapter(webNextUrl));
  void renderWebShelf();

  // 書源底部導覽列
  $("nr-back").addEventListener("click", closeNovelReader);
  $("nr-prev").addEventListener("click", () => void gotoChapter(webPrevUrl));
  $("nr-next").addEventListener("click", () => void gotoChapter(webNextUrl));
  $("nr-toc").addEventListener("click", () => void openToc());
  $("nr-tts").addEventListener("click", toggleTts);
  $("nr-toc-close").addEventListener("click", closeToc);
  $("nr-toc-backdrop").addEventListener("click", closeToc);

  // 書源設定面板（語速 / 字體）
  $("nr-set").addEventListener("click", openSettings);
  $("nr-set-close").addEventListener("click", closeSettings);
  $("nr-set-backdrop").addEventListener("click", closeSettings);
  const nrRate = $<HTMLInputElement>("nr-rate");
  nrRate.addEventListener("input", () => {
    ttsRateInput.value = nrRate.value; // 同步既有控制項，currentRate() 仍可用
    const r = currentRate();
    $("nr-rate-value").textContent = r.toFixed(1);
    ttsRateValue.textContent = r.toFixed(1);
  });
  nrRate.addEventListener("change", () => {
    localStorage.setItem("ttsRate", String(currentRate()));
    if (ttsActive && !ttsPaused) speakFrom(ttsPos); // 朗讀中變速 → 以新語速重唸
  });
  $("nr-font-minus").addEventListener("click", () => {
    fontSize = Math.max(14, fontSize - 1);
    applyFontSize();
  });
  $("nr-font-plus").addEventListener("click", () => {
    fontSize = Math.min(30, fontSize + 1);
    applyFontSize();
  });

  // 預載（本書，設定面板內）
  $("nr-pre-50").addEventListener("click", () => void runPreload(50));
  $("nr-pre-100").addEventListener("click", () => void runPreload(100));
  $("nr-pre-go").addEventListener("click", () => {
    const n = parseInt($<HTMLInputElement>("nr-pre-custom").value, 10);
    void runPreload(n);
  });
  $("nr-pre-cancel").addEventListener("click", () => {
    preloadCancel = true;
  });

  // 離線預載管理（小說分頁）
  $("btn-preload-mgr").addEventListener("click", () => void openPreloadManager());
  $("pre-close").addEventListener("click", () =>
    $<HTMLDialogElement>("preload-dialog").close()
  );
  $("pre-clear-all").addEventListener("click", async () => {
    await invoke("preload_delete_all").catch(() => {});
    await renderPreloadList();
  });
  $<HTMLInputElement>("pre-retain").addEventListener("change", () => {
    const days = Math.max(0, parseInt($<HTMLInputElement>("pre-retain").value, 10) || 0);
    void invoke("preload_set_retain_days", { days });
  });

  // 底部列自動隱藏：下滑內文收起、底部邊緣上滑或點拉把叫出（兩種模式共用）
  setupAutoHideBar({
    onShow: showBottomBar,
    onHide: hideBottomBar,
    scrollEls: [novelScroll],
    rootEl: novelReaderView,
    handleEl: $("nr-bar-handle"),
    isActive: isNovelReaderOpen,
  });

  $("novel-font-minus").addEventListener("click", () => {
    fontSize = Math.max(14, fontSize - 1);
    applyFontSize();
  });
  $("novel-font-plus").addEventListener("click", () => {
    fontSize = Math.min(30, fontSize + 1);
    applyFontSize();
  });

  btnTtsPlay.addEventListener("click", () => speakFrom(ttsActive ? ttsPos : ttsPos || 0));
  btnTtsPause.addEventListener("click", pauseOrResumeTts);
  $("btn-tts-stop").addEventListener("click", stopTts);

  ttsRateInput.addEventListener("input", () => {
    ttsRateValue.textContent = currentRate().toFixed(1);
  });
  ttsRateInput.addEventListener("change", () => {
    localStorage.setItem("ttsRate", String(currentRate()));
    // 朗讀中變更語速 → 以新語速重唸目前段落
    if (ttsActive && !ttsPaused) speakFrom(ttsPos);
  });
  ttsVoiceSelect.addEventListener("change", () => {
    localStorage.setItem("ttsVoice", ttsVoiceSelect.value);
    if (ttsActive && !ttsPaused) speakFrom(ttsPos);
  });

  const savedRate = localStorage.getItem("ttsRate");
  if (savedRate) {
    ttsRateInput.value = savedRate;
    ttsRateValue.textContent = parseFloat(savedRate).toFixed(1);
  }

  if (isAndroid) {
    // 原生 TTS：監聽外掛事件推進段落；語音選擇交給系統設定
    void addPluginListener("androidbridge", "done", () => {
      if (!ttsActive || ttsPaused) return;
      ttsPos++;
      speakCurrent();
    });
    void addPluginListener("androidbridge", "error", () => {
      if (ttsActive) stopTts();
    });
  } else {
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }

  document.addEventListener("keydown", async (ev) => {
    if (!isNovelReaderOpen()) return;
    if (ev.key === "Escape") {
      if (await exitFullscreenIfAny()) return;
      closeNovelReader();
    }
  });

  if (novelFolder) void loadNovels();
}
