import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, showToast, asCmdError, isAndroid } from "./util";

interface Source {
  name: string;
  url: string;
}

const sourcesGrid = $("sources-grid");
const sourceName = $<HTMLInputElement>("source-name");
const sourceUrl = $<HTMLInputElement>("source-url");

async function loadSources() {
  const list = await invoke<Source[]>("get_sources");
  sourcesGrid.innerHTML = "";
  if (list.length === 0) {
    sourcesGrid.innerHTML = '<p class="empty-hint">尚無來源，請於下方新增</p>';
    return;
  }
  list.forEach((src, idx) => {
    const card = document.createElement("button");
    card.className = "source-card";
    card.style.setProperty("--i", String(idx));
    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = src.name;
    const url = document.createElement("span");
    url.className = "source-url";
    url.textContent = src.url;
    const del = document.createElement("span");
    del.className = "source-del";
    del.textContent = "刪除";
    del.title = "從清單移除";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await invoke("remove_source", { url: src.url }).catch(() => {});
      await loadSources();
    });
    card.append(name, url, del);
    card.addEventListener("click", async () => {
      try {
        if (isAndroid) {
          // Android 為單視窗，改以系統瀏覽器開啟
          await openUrl(src.url);
        } else {
          await invoke("open_browser", { url: src.url, title: src.name });
        }
      } catch (e) {
        showToast("開啟失敗：" + asCmdError(e).message);
      }
    });
    sourcesGrid.appendChild(card);
  });
}

export function initSources() {
  void loadSources();

  $<HTMLFormElement>("source-add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = sourceName.value.trim();
    let url = sourceUrl.value.trim();
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      await invoke("add_source", { name, url });
      sourceName.value = "";
      sourceUrl.value = "";
      await loadSources();
    } catch (e) {
      showToast("新增失敗：" + asCmdError(e).message);
    }
  });
}
