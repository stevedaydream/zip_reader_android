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

// ---------- 狀態 ----------
let novelFolder: string | null = localStorage.getItem("novelFolder");
let fontSize = parseInt(localStorage.getItem("novelFontSize") ?? "19", 10);
let paragraphs: HTMLParagraphElement[] = [];
let ttsPos = 0;
let ttsActive = false;
let ttsPaused = false;
let voices: SpeechSynthesisVoice[] = [];
let appShell: HTMLElement;

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

// ---------- 閱讀 ----------
async function openNovel(item: FileItem) {
  let text: string;
  try {
    text = await invoke<string>("read_text_file", { path: item.path });
  } catch (e) {
    showToast("開啟失敗：" + asCmdError(e).message);
    return;
  }
  novelTitle.textContent = item.name.replace(EXT_RE, "");
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
  novelReaderView.classList.remove("hidden");
  novelScroll.scrollTop = 0;
  ttsPos = 0;
}

export function closeNovelReader() {
  stopTts();
  novelReaderView.classList.add("hidden");
  appShell.classList.remove("hidden");
  novelContent.innerHTML = "";
  paragraphs = [];
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
  if (!ttsActive || ttsPos >= paragraphs.length) {
    stopTts();
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
