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
  novelScroll.scrollTop = 0;
  ttsPos = 0;
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
  bookCtx = null;
  updateChapterNav();
  renderNovelText(item.name.replace(EXT_RE, ""), text);
}

export function closeNovelReader() {
  stopTts();
  novelReaderView.classList.add("hidden");
  novelContent.innerHTML = "";
  paragraphs = [];
  webMode = false;
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
}

/** 開啟網路小說章節；bookName 為書架名（首次開啟用章節標題建檔） */
async function openWebChapter(url: string, bookName?: string | null): Promise<boolean> {
  if (webLoading) return false;
  webLoading = true;
  showToast("正在載入章節…");
  try {
    const ch = await invoke<WebChapter>("fetch_web_chapter", { url });
    stopTts();
    webMode = true;
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
  webBookName = ctx.name;
  await openWebChapter(url, ctx.name);
}

async function gotoChapter(url: string | null) {
  if (!url) return;
  const wasReading = ttsActive && !ttsPaused;
  const ok = await openWebChapter(url);
  if (ok && wasReading) speakFrom(0);
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
    card.addEventListener("click", () => void openWebChapter(item.url, item.name));
    shelf.appendChild(card);
  });
}

function applyFontSize() {
  novelContent.style.fontSize = fontSize + "px";
  localStorage.setItem("novelFontSize", String(fontSize));
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
  speakCurrent();
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
  cancelSpeech();
  clearHighlight();
  btnTtsPlay.classList.remove("active");
  btnTtsPause.textContent = "暫停";
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
