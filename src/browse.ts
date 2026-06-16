import { invoke } from "@tauri-apps/api/core";
import { $, showToast, asCmdError, setupAutoHideBar } from "./util";
import { openSourceChapter } from "./novel";

interface Category {
  name: string;
  url: string;
}
interface BookEntry {
  name: string;
  author: string;
  url: string;
}
interface Chapter {
  title: string;
  url: string;
}
interface BookDetail {
  name: string;
  author: string;
  category: string;
  status: string;
  intro: string;
  url: string;
  chapters: Chapter[];
}
interface Favorite {
  name: string;
  author: string;
  book_url: string;
  chapter_url: string;
  chapter_title: string;
}

const view = () => $("browse-view");
const titleEl = () => $("browse-title");
const bodyEl = () => $("browse-body");
const searchInput = () => $<HTMLInputElement>("browse-search");

function setLoading(msg = "載入中…") {
  bodyEl().innerHTML = `<p class="browse-loading">${msg}</p>`;
}

let shell: HTMLElement | null = null;

export function setBrowseShell(el: HTMLElement) {
  shell = el;
}

export function showBrowse() {
  shell?.classList.add("hidden");
  view().classList.remove("hidden");
  view().classList.remove("chrome-hidden"); // 進入時顯示底部工具列
}

export function closeBrowse() {
  view().classList.add("hidden");
  shell?.classList.remove("hidden");
}

/** 開啟書源瀏覽器（首頁 = 分類 + 我的最愛） */
export async function openBrowse() {
  showBrowse();
  await renderHome();
}

async function renderHome() {
  titleEl().textContent = "黃金屋書源";
  setLoading();
  const [cats, favs] = await Promise.all([
    invoke<Category[]>("hjwzw_categories").catch(() => [] as Category[]),
    invoke<Favorite[]>("get_favorites").catch(() => [] as Favorite[]),
  ]);

  const body = bodyEl();
  body.innerHTML = "";

  // 我的最愛
  if (favs.length > 0) {
    const sec = document.createElement("div");
    sec.className = "browse-section";
    sec.innerHTML = `<h3 class="browse-h">我的最愛</h3>`;
    const grid = document.createElement("div");
    grid.className = "sources-grid";
    favs.forEach((f, i) => grid.appendChild(favCard(f, i)));
    sec.appendChild(grid);
    body.appendChild(sec);
  }

  // 分類
  const sec = document.createElement("div");
  sec.className = "browse-section";
  sec.innerHTML = `<h3 class="browse-h">分類</h3>`;
  const catWrap = document.createElement("div");
  catWrap.className = "cat-chips";
  cats.forEach((c) => {
    const chip = document.createElement("button");
    chip.className = "cat-chip";
    chip.textContent = c.name;
    chip.addEventListener("click", () => void renderBookList(c.name, c.url));
    catWrap.appendChild(chip);
  });
  sec.appendChild(catWrap);
  body.appendChild(sec);
}

function favCard(f: Favorite, idx: number): HTMLElement {
  const card = document.createElement("button");
  card.className = "source-card";
  card.style.setProperty("--i", String(idx));
  const name = document.createElement("span");
  name.className = "source-name";
  name.textContent = f.name;
  const meta = document.createElement("span");
  meta.className = "source-url";
  meta.textContent = f.chapter_title
    ? `${f.author}　·　讀到：${f.chapter_title}`
    : f.author;
  const del = document.createElement("span");
  del.className = "source-del";
  del.textContent = "移除";
  del.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    await invoke("remove_favorite", { bookUrl: f.book_url }).catch(() => {});
    await renderHome();
  });
  card.append(name, meta, del);
  // 點最愛 → 從續讀章節開始（無進度則進書籍目錄）
  card.addEventListener("click", () => {
    if (f.chapter_url) {
      void openSourceChapter(f.chapter_url, {
        name: f.name,
        author: f.author,
        bookUrl: f.book_url,
      });
    } else {
      void renderBookDetail(f.book_url);
    }
  });
  return card;
}

async function renderBookList(catName: string, url: string) {
  titleEl().textContent = catName;
  setLoading();
  let books: BookEntry[];
  try {
    books = await invoke<BookEntry[]>("hjwzw_book_list", { url });
  } catch (e) {
    bodyEl().innerHTML = `<p class="browse-loading">載入失敗：${asCmdError(e).message}</p>`;
    return;
  }
  renderBookEntries(books);
}

function renderBookEntries(books: BookEntry[]) {
  const body = bodyEl();
  body.innerHTML = "";
  if (books.length === 0) {
    body.innerHTML = `<p class="browse-loading">沒有結果</p>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "sources-grid";
  books.forEach((b, i) => {
    const card = document.createElement("button");
    card.className = "source-card";
    card.style.setProperty("--i", String(Math.min(i, 20)));
    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = b.name;
    const author = document.createElement("span");
    author.className = "source-url";
    author.textContent = b.author;
    card.append(name, author);
    card.addEventListener("click", () => void renderBookDetail(b.url));
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

async function renderBookDetail(bookUrl: string) {
  titleEl().textContent = "書籍詳情";
  setLoading();
  let d: BookDetail;
  try {
    d = await invoke<BookDetail>("hjwzw_book_detail", { url: bookUrl });
  } catch (e) {
    bodyEl().innerHTML = `<p class="browse-loading">載入失敗：${asCmdError(e).message}</p>`;
    return;
  }
  titleEl().textContent = d.name;
  const faved = await invoke<boolean>("is_favorite", { bookUrl }).catch(() => false);

  const body = bodyEl();
  body.innerHTML = "";

  // 書籍資訊
  const info = document.createElement("div");
  info.className = "book-info";
  const meta = [d.author, d.category, d.status].filter(Boolean).join("　·　");
  info.innerHTML = `
    <div class="book-info-name"></div>
    <div class="book-info-meta"></div>
    <div class="book-info-intro"></div>`;
  info.querySelector(".book-info-name")!.textContent = d.name;
  info.querySelector(".book-info-meta")!.textContent = meta;
  info.querySelector(".book-info-intro")!.textContent = d.intro;

  const actions = document.createElement("div");
  actions.className = "book-actions";
  const favBtn = document.createElement("button");
  favBtn.className = "primary";
  let isFav = faved;
  const paintFav = () => {
    favBtn.textContent = isFav ? "★ 已收藏（點此移除）" : "☆ 加入我的最愛";
  };
  paintFav();
  favBtn.addEventListener("click", async () => {
    if (isFav) {
      await invoke("remove_favorite", { bookUrl }).catch(() => {});
      isFav = false;
      showToast("已移除收藏");
    } else {
      await invoke("upsert_favorite", {
        name: d.name,
        author: d.author,
        bookUrl,
        chapterUrl: "",
        chapterTitle: "",
      }).catch(() => {});
      isFav = true;
      showToast("已加入我的最愛");
    }
    paintFav();
  });
  const readBtn = document.createElement("button");
  readBtn.textContent = "從第一章開始";
  readBtn.addEventListener("click", () => {
    if (d.chapters[0]) {
      void openSourceChapter(d.chapters[0].url, {
        name: d.name,
        author: d.author,
        bookUrl,
      });
    }
  });
  actions.append(favBtn, readBtn);
  info.appendChild(actions);
  body.appendChild(info);

  // 目錄
  const tocHead = document.createElement("h3");
  tocHead.className = "browse-h";
  tocHead.textContent = `目錄（共 ${d.chapters.length} 章）`;
  body.appendChild(tocHead);

  const toc = document.createElement("div");
  toc.className = "toc-list";
  for (const ch of d.chapters) {
    const item = document.createElement("button");
    item.className = "toc-item";
    item.textContent = ch.title;
    item.addEventListener("click", () => {
      void openSourceChapter(ch.url, {
        name: d.name,
        author: d.author,
        bookUrl,
      });
    });
    toc.appendChild(item);
  }
  body.appendChild(toc);
}

async function doSearch() {
  const kw = searchInput().value.trim();
  if (!kw) return;
  titleEl().textContent = `搜尋：${kw}`;
  setLoading("搜尋中…");
  let books: BookEntry[];
  try {
    books = await invoke<BookEntry[]>("hjwzw_search", { keyword: kw });
  } catch (e) {
    bodyEl().innerHTML = `<p class="browse-loading">搜尋失敗：${asCmdError(e).message}</p>`;
    return;
  }
  renderBookEntries(books);
}

export function initBrowse(shellEl: HTMLElement) {
  setBrowseShell(shellEl);
  $("browse-back").addEventListener("click", closeBrowse);
  $("browse-home").addEventListener("click", () => void renderHome());
  $("browse-search-btn").addEventListener("click", () => void doSearch());
  searchInput().addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void doSearch();
  });

  // 底部工具列自動隱藏
  setupAutoHideBar({
    onShow: () => view().classList.remove("chrome-hidden"),
    onHide: () => view().classList.add("chrome-hidden"),
    scrollEls: [bodyEl()],
    rootEl: view(),
    handleEl: $("browse-bar-handle"),
    isActive: () => !view().classList.contains("hidden"),
  });
}
