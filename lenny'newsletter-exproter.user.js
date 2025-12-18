// ==UserScript==
// @name         Lenny's Newsletter Exporter (Fast, Concurrency + Batch/ZIP)
// @namespace    https://tampermonkey.net/
// @version      0.5
// @description  Export Lenny's Newsletter archive posts to Markdown. Batch MD or per-post MD in ZIP. User-configurable concurrency + retry/backoff.
// @match        https://www.lennysnewsletter.com/archive*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.2/dist/turndown.js
// @require      https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(() => {
  "use strict";

  // ========= 基本参数（可在面板中改并发/重试等） =========
  const ARCHIVE_API = "/api/v1/archive?sort=new&search="; // offset & limit 追加在后面
  const PAGE_SIZE = 50;

  const FILE_PREFIX = "lennysnewsletter_export";
  const INCLUDE_FRONT_MATTER = false; // true: 每篇加 YAML front matter

  // Batch 模式：每多少篇合并成一个 .md
  const DEFAULT_DOWNLOAD_BATCH = 20;

  // 默认模式： "batch" | "zip"
  const DEFAULT_MODE = "batch";

  // 默认并发（建议 4~6，过高更容易 429/失败）
  const DEFAULT_CONCURRENCY = 6;

  // 重试策略默认值
  const DEFAULT_MAX_RETRIES = 5;
  const DEFAULT_BACKOFF_BASE_MS = 500;

  // ZIP 性能：level=1 更快；streamFiles 可省内存
  const DEFAULT_ZIP_LEVEL = 1;
  const DEFAULT_ZIP_STREAM_FILES = false;

  // ========= 状态 =========
  let cancelled = false;

  // ========= UI =========
  GM_addStyle(`
    #lnexp_btn {
      position: fixed; right: 18px; bottom: 18px; z-index: 999999;
      padding: 10px 12px; border-radius: 12px;
      background: #111; color: #fff; font-size: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.25);
      cursor: pointer; user-select: none;
    }
    #lnexp_panel {
      position: fixed; right: 18px; bottom: 64px; z-index: 999999;
      width: 420px; max-height: 68vh; overflow: auto;
      background: #fff; color: #111; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
      border: 1px solid rgba(0,0,0,.08);
      display: none;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    #lnexp_panel header {
      padding: 12px 12px; border-bottom: 1px solid rgba(0,0,0,.08);
      display: flex; align-items: center; justify-content: space-between;
      font-weight: 650;
      gap: 10px;
    }
    #lnexp_panel header .actions button{
      margin-left: 6px; padding: 6px 8px; border-radius: 10px; border: 1px solid rgba(0,0,0,.12);
      background: #fafafa; cursor: pointer;
    }
    #lnexp_panel .body { padding: 10px 12px; font-size: 12px; line-height: 1.45; }
    #lnexp_panel .bar {
      width: 100%; height: 8px; background: rgba(0,0,0,.08); border-radius: 999px; overflow: hidden;
      margin: 8px 0 10px;
    }
    #lnexp_panel .bar > div { height: 100%; width: 0%; background: #111; }
    #lnexp_panel pre {
      background: #0b1020; color: #d6e0ff; padding: 10px; border-radius: 12px;
      white-space: pre-wrap; word-break: break-word;
      margin-top: 10px;
    }
    .lnexp_grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin: 10px 0;
    }
    .lnexp_field label {
      display: block;
      font-size: 11px;
      color: rgba(0,0,0,.65);
      margin-bottom: 4px;
    }
    .lnexp_field input, .lnexp_field select {
      width: 100%;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(0,0,0,.12);
      background: #fafafa;
      font-size: 12px;
      box-sizing: border-box;
    }
    #lnexp_hint {
      color: rgba(0,0,0,.6);
      margin-top: 6px;
      font-size: 11px;
    }
  `);

  const btn = document.createElement("div");
  btn.id = "lnexp_btn";
  btn.textContent = "Export Markdown";
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "lnexp_panel";

  panel.innerHTML = `
    <header>
      <div>导出设置</div>
      <div class="actions">
        <button id="lnexp_stop">Stop</button>
        <button id="lnexp_hide">Hide</button>
      </div>
    </header>
    <div class="body">
      <div class="lnexp_grid">
        <div class="lnexp_field">
          <label>模式</label>
          <select id="lnexp_mode">
            <option value="batch">Batch：多篇合并 .md（分批下载）</option>
            <option value="zip">ZIP：单篇 .md 打包成 zip</option>
          </select>
        </div>
        <div class="lnexp_field">
          <label>并发（1~12）</label>
          <input id="lnexp_concurrency" type="number" min="1" max="12" step="1" />
        </div>

        <div class="lnexp_field">
          <label>重试次数（429/5xx）</label>
          <input id="lnexp_retries" type="number" min="0" max="10" step="1" />
        </div>
        <div class="lnexp_field">
          <label>退避基数 ms</label>
          <input id="lnexp_backoff" type="number" min="100" max="5000" step="50" />
        </div>

        <div class="lnexp_field">
          <label>Batch：每文件合并篇数</label>
          <input id="lnexp_batchsize" type="number" min="1" max="200" step="1" />
        </div>
        <div class="lnexp_field">
          <label>ZIP：压缩等级（1快~9小）</label>
          <input id="lnexp_ziplevel" type="number" min="1" max="9" step="1" />
        </div>
      </div>

      <div class="lnexp_field" style="margin-top:6px;">
        <label><input id="lnexp_streamfiles" type="checkbox" /> ZIP：streamFiles（更省内存）</label>
      </div>

      <div id="lnexp_status">Ready.</div>
      <div class="bar"><div id="lnexp_bar"></div></div>
      <div id="lnexp_hint">
        建议并发从 4~6 开始；太大可能触发 429（脚本会按 Retry-After/指数退避自动重试）。
      </div>

      <pre id="lnexp_log"></pre>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const logEl = $("#lnexp_log");
  const statusEl = $("#lnexp_status");
  const barEl = $("#lnexp_bar");

  const modeSel = $("#lnexp_mode");
  const concInput = $("#lnexp_concurrency");
  const retriesInput = $("#lnexp_retries");
  const backoffInput = $("#lnexp_backoff");
  const batchSizeInput = $("#lnexp_batchsize");
  const zipLevelInput = $("#lnexp_ziplevel");
  const streamFilesInput = $("#lnexp_streamfiles");

  // 读取持久化设置
  modeSel.value = GM_getValue("mode", DEFAULT_MODE);
  concInput.value = GM_getValue("concurrency", DEFAULT_CONCURRENCY);
  retriesInput.value = GM_getValue("maxRetries", DEFAULT_MAX_RETRIES);
  backoffInput.value = GM_getValue("backoffBaseMs", DEFAULT_BACKOFF_BASE_MS);
  batchSizeInput.value = GM_getValue("batchSize", DEFAULT_DOWNLOAD_BATCH);
  zipLevelInput.value = GM_getValue("zipLevel", DEFAULT_ZIP_LEVEL);
  streamFilesInput.checked = GM_getValue("zipStreamFiles", DEFAULT_ZIP_STREAM_FILES);

  function persistSettings() {
    GM_setValue("mode", modeSel.value);
    GM_setValue("concurrency", parseInt(concInput.value, 10) || DEFAULT_CONCURRENCY);
    GM_setValue("maxRetries", parseInt(retriesInput.value, 10) || DEFAULT_MAX_RETRIES);
    GM_setValue("backoffBaseMs", parseInt(backoffInput.value, 10) || DEFAULT_BACKOFF_BASE_MS);
    GM_setValue("batchSize", parseInt(batchSizeInput.value, 10) || DEFAULT_DOWNLOAD_BATCH);
    GM_setValue("zipLevel", parseInt(zipLevelInput.value, 10) || DEFAULT_ZIP_LEVEL);
    GM_setValue("zipStreamFiles", !!streamFilesInput.checked);
  }

  [modeSel, concInput, retriesInput, backoffInput, batchSizeInput, zipLevelInput, streamFilesInput]
    .forEach(el => el.addEventListener("change", persistSettings));

  function showPanel() { panel.style.display = "block"; }
  function hidePanel() { panel.style.display = "none"; }
  function log(msg) {
    logEl.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    console.log("[LN-EXPORT]", msg);
  }
  function setStatus(msg) { statusEl.textContent = msg; }
  function setProgress(pct) { barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  $("#lnexp_hide").addEventListener("click", hidePanel);
  $("#lnexp_stop").addEventListener("click", () => {
    cancelled = true;
    log("Cancelled by user.");
    setStatus("Cancelled.");
  });

  btn.addEventListener("click", () => run().catch(err => {
    showPanel();
    log(`ERROR: ${err?.stack || err}`);
    setStatus("Error.");
  }));

  GM_registerMenuCommand("Export Lenny's Newsletter archive to Markdown", () => btn.click());

  // ========= Markdown 转换 =========
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  try {
    // gfm: tables / strikethrough / taskListItems 等
    turndownService.use(turndownPluginGfm.gfm);
  } catch (_) {}

  turndownService.addRule("iframesToLink", {
    filter: ["iframe"],
    replacement: function (content, node) {
      const src = node.getAttribute("src");
      return src ? `\n\n[Embedded content](${src})\n\n` : "\n\n";
    }
  });

  turndownService.addRule("figureRule", {
    filter: function (node) { return node.nodeName === "FIGURE"; },
    replacement: function (content, node) {
      const img = node.querySelector("img");
      const cap = node.querySelector("figcaption");
      let md = "";
      if (img) {
        const alt = (img.getAttribute("alt") || "").trim().replace(/\$/g, "");
        const src = img.getAttribute("src") || "";
        md += `![${alt}](${src})\n`;
      }
      if (cap) {
        const capText = cap.textContent.trim();
        if (capText) md += `\n_${capText}_\n`;
      }
      return `\n\n${md}\n\n`;
    }
  });

  function cleanupMarkdown(md) {
    return md
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim() + "\n";
  }

  // ========= 文件名安全处理（Windows/macOS/Linux） =========
  const WINDOWS_RESERVED = new Set([
    "CON","PRN","AUX","NUL",
    "COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9",
    "LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"
  ]);

  function sanitizeFilename(name) {
    let s = String(name || "").trim();
    s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[. ]+$/g, "");
    if (!s) s = "Untitled";
    if (WINDOWS_RESERVED.has(s.toUpperCase())) s = "_" + s;
    if (s.length > 140) s = s.slice(0, 140).trim();
    if (!s) s = "Untitled";
    return s;
  }

  function makeUniqueMdFilename(title, seenMap) {
    const base = sanitizeFilename(title);
    const n = seenMap.get(base) || 0;
    seenMap.set(base, n + 1);
    return n === 0 ? `${base}.md` : `${base} (${n + 1}).md`;
  }

  // ========= 下载工具 =========
  function downloadBlob(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function downloadText(filename, text) {
    downloadBlob(filename, new Blob([text], { type: "text/markdown;charset=utf-8" }));
  }

  function safeFilePart(n) { return String(n).padStart(3, "0"); }

  // ========= 重试 + 指数退避（支持 Retry-After） =========
  function jitter(ms) {
    return ms * (0.7 + Math.random() * 0.6);
  }

  function parseRetryAfter(value) {
    // Retry-After 可以是秒数，也可以是 HTTP 日期
    if (!value) return null;
    const s = value.trim();

    // 秒数
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;

    // HTTP-date
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const wait = t - Date.now();
      return wait > 0 ? wait : 0;
    }
    return null;
  }

  async function fetchWithRetry(url, options, cfg) {
    const { maxRetries, backoffBaseMs } = cfg;
    let attempt = 0;

    while (true) {
      const resp = await fetch(url, options);

      if (resp.ok) return resp;

      const retriable = [429, 500, 502, 503, 504].includes(resp.status);
      if (!retriable || attempt >= maxRetries) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} - ${url}`);
      }

      let wait = backoffBaseMs * (2 ** attempt);

      // 429 时尊重 Retry-After（如果存在）
      if (resp.status === 429) {
        const ra = parseRetryAfter(resp.headers.get("Retry-After"));
        if (ra !== null) wait = Math.max(wait, ra);
      }

      wait = jitter(wait);
      log(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(wait)}ms (HTTP ${resp.status}): ${url}`);
      await sleep(wait);
      attempt++;
    }
  }

  // ========= 受控并发池 =========
  async function promisePool(items, worker, concurrency) {
    let cursor = 0;
    const runners = Array.from({ length: concurrency }, async () => {
      while (!cancelled) {
        const i = cursor++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    });
    await Promise.all(runners);
  }

  // ========= 拉取 archive 列表 =========
  async function fetchAllArchivePosts(cfg) {
    let all = [];
    let offset = 0;

    while (!cancelled) {
      const url = `${ARCHIVE_API}&offset=${offset}&limit=${PAGE_SIZE}`;
      log(`Fetch archive: offset=${offset}, limit=${PAGE_SIZE}`);
      const resp = await fetchWithRetry(url, { credentials: "include" }, cfg);
      const data = await resp.json();

      if (!Array.isArray(data) || data.length === 0) break;

      all.push(...data);
      offset += data.length;
      if (data.length < PAGE_SIZE) break;

      await sleep(120);
    }

    // 去重（按 canonical_url）
    const seen = new Set();
    const deduped = [];
    for (const p of all) {
      const u = p?.canonical_url || p?.canonicalUrl || p?.url;
      if (!u) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      deduped.push(p);
    }
    return deduped;
  }

  // ========= 抓单篇文章并转 md =========
  function parseJsonLd(doc) {
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      try {
        const json = JSON.parse(s.textContent.trim());
        const candidates = Array.isArray(json) ? json : [json];
        for (const c of candidates) {
          const t = c?.["@type"];
          if (!t) continue;
          const types = Array.isArray(t) ? t : [t];
          if (types.some(x => String(x).toLowerCase().includes("article"))) return c;
        }
      } catch (_) {}
    }
    return null;
  }

  function extractMeta(doc, fallbackFromArchive, url) {
    const title =
      doc.querySelector("h1")?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
      fallbackFromArchive?.title ||
      "Untitled";

    const metaTime =
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
      doc.querySelector("time")?.getAttribute("datetime") ||
      null;

    const jsonld = parseJsonLd(doc);
    const jsonldDate = jsonld?.datePublished || jsonld?.dateCreated || null;

    const dateRaw =
      jsonldDate ||
      metaTime ||
      fallbackFromArchive?.post_date ||
      fallbackFromArchive?.published_at ||
      fallbackFromArchive?.publication_date ||
      "";

    let author =
      doc.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
      "";

    const jsonldAuthor = jsonld?.author;
    if (!author && jsonldAuthor) {
      if (Array.isArray(jsonldAuthor)) author = jsonldAuthor.map(a => a?.name).filter(Boolean).join(", ");
      else author = jsonldAuthor?.name || "";
    }

    const subtitle =
      doc.querySelector("h3")?.textContent?.trim() ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ||
      "";

    return { title, author, dateRaw, subtitle, url };
  }

  function extractArticleContentElement(doc) {
    let el = doc.querySelector("article");
    if (!el) el = doc.querySelector(".available-content");
    if (!el) el = doc.querySelector(".post-content");
    if (!el) el = doc.querySelector("main");
    if (!el) return null;

    const clone = el.cloneNode(true);

    // 去掉导航/按钮/订阅引导等（不做“绕过”，只是减少噪音）
    const junkSelectors = [
      "nav",
      "footer",
      'a[href*="subscribe"]',
      'a[href*="signin"]',
      'button',
      'form',
      '[role="button"]',
      ".share",
      ".post-actions",
      ".subscription-widget",
      ".paywall",
      '[data-testid*="paywall"]',
      '[data-testid*="subscription"]'
    ];
    clone.querySelectorAll(junkSelectors.join(",")).forEach(n => n.remove());

    return clone;
  }

  async function fetchPostMarkdown(post, index, total, cfg) {
    const url = post?.canonical_url || post?.canonicalUrl || post?.url;
    if (!url) throw new Error("Missing canonical_url");

    setStatus(`(${index + 1}/${total}) Fetch: ${url}`);
    log(`Fetch post: ${url}`);

    const resp = await fetchWithRetry(url, { credentials: "include" }, cfg);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const meta = extractMeta(doc, post, url);
    const contentEl = extractArticleContentElement(doc);
    if (!contentEl) throw new Error(`Cannot find article content for: ${url}`);

    let bodyMd = turndownService.turndown(contentEl);
    bodyMd = cleanupMarkdown(bodyMd);

    let out = "";
    if (INCLUDE_FRONT_MATTER) {
      const safe = (s) => String(s || "").replace(/"/g, '\\"');
      out += `---\n`;
      out += `title: "${safe(meta.title)}"\n`;
      out += meta.dateRaw ? `date: "${safe(meta.dateRaw)}"\n` : "";
      out += meta.author ? `author: "${safe(meta.author)}"\n` : "";
      out += `url: "${safe(meta.url)}"\n`;
      out += `---\n\n`;
    }

    out += `# ${meta.title}\n\n`;
    if (meta.subtitle) out += `> ${meta.subtitle}\n\n`;
    if (meta.dateRaw) out += `- 日期：${meta.dateRaw}\n`;
    if (meta.author) out += `- 作者：${meta.author}\n`;
    out += `- 链接：${meta.url}\n\n`;
    out += bodyMd;
    out += `\n\n---\n\n`;

    return { md: out, meta };
  }

  // ========= 主流程 =========
  async function run() {
    cancelled = false;
    showPanel();
    logEl.textContent = "";
    setProgress(0);

    // 读取面板设置（并夹取范围）
    persistSettings();

    const mode = modeSel.value;
    const concurrency = clampInt(parseInt(concInput.value, 10), 1, 12, DEFAULT_CONCURRENCY);
    const maxRetries = clampInt(parseInt(retriesInput.value, 10), 0, 10, DEFAULT_MAX_RETRIES);
    const backoffBaseMs = clampInt(parseInt(backoffInput.value, 10), 100, 5000, DEFAULT_BACKOFF_BASE_MS);
    const batchSize = clampInt(parseInt(batchSizeInput.value, 10), 1, 200, DEFAULT_DOWNLOAD_BATCH);
    const zipLevel = clampInt(parseInt(zipLevelInput.value, 10), 1, 9, DEFAULT_ZIP_LEVEL);
    const zipStreamFiles = !!streamFilesInput.checked;

    const cfg = { concurrency, maxRetries, backoffBaseMs, batchSize, zipLevel, zipStreamFiles };

    log(`Mode=${mode}, Concurrency=${cfg.concurrency}, Retries=${cfg.maxRetries}, BackoffBaseMs=${cfg.backoffBaseMs}`);
    if (mode === "batch") log(`BatchSize=${cfg.batchSize}`);
    if (mode === "zip") log(`ZipLevel=${cfg.zipLevel}, streamFiles=${cfg.zipStreamFiles}`);

    setStatus("Loading archive list...");
    const posts = await fetchAllArchivePosts(cfg);
    if (cancelled) return;

    log(`Archive posts: ${posts.length}`);
    if (!posts.length) {
      setStatus("No posts found. Are you logged in / is the page accessible?");
      return;
    }

    if (mode === "batch") {
      await runBatch(posts, cfg);
    } else if (mode === "zip") {
      await runZip(posts, cfg);
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
  }

  function clampInt(v, min, max, fallback) {
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }

  // ========= Batch：并发抓取 + 保序输出 =========
  async function runBatch(posts, cfg) {
    const pending = new Map(); // index -> { ok, md }
    let next = 0;

    let buffer = [];
    let batchNo = 1;
    let exported = 0;
    let finished = 0;

    const flush = async () => {
      while (pending.has(next)) {
        const item = pending.get(next);
        pending.delete(next);
        next++;

        if (item.ok) buffer.push(item.md);

        if (buffer.length >= cfg.batchSize) {
          const filename = `${FILE_PREFIX}_part_${safeFilePart(batchNo)}.md`;
          downloadText(filename, buffer.join(""));
          log(`Downloaded: ${filename} (${buffer.length} posts)`);
          buffer = [];
          batchNo++;
          await sleep(200);
        }
      }
    };

    await promisePool(posts, async (post, i) => {
      if (cancelled) return;

      try {
        const { md } = await fetchPostMarkdown(post, i, posts.length, cfg);
        pending.set(i, { ok: true, md });
        exported++;
      } catch (e) {
        log(`WARN: failed #${i + 1}: ${e?.message || e}`);
        pending.set(i, { ok: false, md: "" }); // 占位保证顺序推进
      } finally {
        finished++;
        setProgress((finished / posts.length) * 100);
        setStatus(`Batch exporting... ${finished}/${posts.length} (success ~${exported})`);
      }

      await flush();
    }, cfg.concurrency);

    await flush();

    if (!cancelled && buffer.length) {
      const filename = `${FILE_PREFIX}_part_${safeFilePart(batchNo)}.md`;
      downloadText(filename, buffer.join(""));
      log(`Downloaded: ${filename} (${buffer.length} posts)`);
    }

    setProgress(100);
    setStatus(`Done (batch). Exported ~${exported}/${posts.length} posts.`);
    log("DONE (batch).");
  }

  // ========= 纯 JS 手动构建 ZIP（不依赖 JSZip，避免卡死） =========
  // ZIP 文件格式参考：https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
  // 使用 STORE（无压缩）模式，简单可靠

  function createZipBlob(files, onProgress) {
    // files: [{ filename: string, content: string }, ...]

    const textEncoder = new TextEncoder();
    const localFileHeaders = [];
    const centralDirectory = [];
    let offset = 0;

    // 处理每个文件
    for (let i = 0; i < files.length; i++) {
      const { filename, content } = files[i];

      // 文件名转 UTF-8 字节
      const filenameBytes = textEncoder.encode(filename);
      // 文件内容转 UTF-8 字节
      const contentBytes = textEncoder.encode(content);

      // CRC32 计算
      const crc = crc32(contentBytes);

      // 当前时间转 DOS 格式
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      // Local file header (30 bytes + filename + content)
      const localHeader = new ArrayBuffer(30);
      const localView = new DataView(localHeader);

      localView.setUint32(0, 0x04034b50, true);  // Local file header signature
      localView.setUint16(4, 20, true);          // Version needed to extract (2.0)
      localView.setUint16(6, 0x0800, true);      // General purpose bit flag (UTF-8 filenames)
      localView.setUint16(8, 0, true);           // Compression method (STORE)
      localView.setUint16(10, dosTime, true);    // Last mod file time
      localView.setUint16(12, dosDate, true);    // Last mod file date
      localView.setUint32(14, crc, true);        // CRC-32
      localView.setUint32(18, contentBytes.length, true);  // Compressed size
      localView.setUint32(22, contentBytes.length, true);  // Uncompressed size
      localView.setUint16(26, filenameBytes.length, true); // File name length
      localView.setUint16(28, 0, true);          // Extra field length

      localFileHeaders.push({
        header: new Uint8Array(localHeader),
        filename: filenameBytes,
        content: contentBytes,
        crc,
        offset,
        dosTime,
        dosDate
      });

      offset += 30 + filenameBytes.length + contentBytes.length;

      // 进度回调
      if (onProgress) {
        onProgress(i + 1, files.length, filename);
      }
    }

    // Central directory
    for (const file of localFileHeaders) {
      const cdHeader = new ArrayBuffer(46);
      const cdView = new DataView(cdHeader);

      cdView.setUint32(0, 0x02014b50, true);   // Central directory file header signature
      cdView.setUint16(4, 20, true);           // Version made by
      cdView.setUint16(6, 20, true);           // Version needed to extract
      cdView.setUint16(8, 0x0800, true);       // General purpose bit flag (UTF-8)
      cdView.setUint16(10, 0, true);           // Compression method (STORE)
      cdView.setUint16(12, file.dosTime, true);// Last mod file time
      cdView.setUint16(14, file.dosDate, true);// Last mod file date
      cdView.setUint32(16, file.crc, true);    // CRC-32
      cdView.setUint32(20, file.content.length, true); // Compressed size
      cdView.setUint32(24, file.content.length, true); // Uncompressed size
      cdView.setUint16(28, file.filename.length, true);// File name length
      cdView.setUint16(30, 0, true);           // Extra field length
      cdView.setUint16(32, 0, true);           // File comment length
      cdView.setUint16(34, 0, true);           // Disk number start
      cdView.setUint16(36, 0, true);           // Internal file attributes
      cdView.setUint32(38, 0, true);           // External file attributes
      cdView.setUint32(42, file.offset, true); // Relative offset of local header

      centralDirectory.push({
        header: new Uint8Array(cdHeader),
        filename: file.filename
      });
    }

    // End of central directory record
    const cdSize = centralDirectory.reduce((sum, cd) => sum + 46 + cd.filename.length, 0);
    const eocd = new ArrayBuffer(22);
    const eocdView = new DataView(eocd);

    eocdView.setUint32(0, 0x06054b50, true);   // End of central directory signature
    eocdView.setUint16(4, 0, true);            // Number of this disk
    eocdView.setUint16(6, 0, true);            // Disk where central directory starts
    eocdView.setUint16(8, files.length, true); // Number of central directory records on this disk
    eocdView.setUint16(10, files.length, true);// Total number of central directory records
    eocdView.setUint32(12, cdSize, true);      // Size of central directory
    eocdView.setUint32(16, offset, true);      // Offset of start of central directory
    eocdView.setUint16(20, 0, true);           // Comment length

    // 组装所有部分
    const parts = [];

    // Local file headers + content
    for (const file of localFileHeaders) {
      parts.push(file.header);
      parts.push(file.filename);
      parts.push(file.content);
    }

    // Central directory
    for (const cd of centralDirectory) {
      parts.push(cd.header);
      parts.push(cd.filename);
    }

    // End of central directory
    parts.push(new Uint8Array(eocd));

    return new Blob(parts, { type: "application/zip" });
  }

  // CRC32 计算（ZIP 标准）
  function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = getCrc32Table();

    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // CRC32 查找表（懒加载）
  let crc32Table = null;
  function getCrc32Table() {
    if (crc32Table) return crc32Table;

    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32Table[i] = c;
    }
    return crc32Table;
  }

  // ========= ZIP：并发抓取 + 单篇文件名=标题.md + 手动打包 =========
  async function runZip(posts, cfg) {
    const seenNames = new Map();
    let exported = 0;
    let finished = 0;

    // 收集所有成功的文件数据
    const collectedFiles = [];

    await promisePool(posts, async (post, i) => {
      if (cancelled) return;

      try {
        const { md, meta } = await fetchPostMarkdown(post, i, posts.length, cfg);
        const filename = makeUniqueMdFilename(meta.title, seenNames);
        collectedFiles.push({ filename, content: md });
        exported++;
        log(`Collected: ${filename} (${exported} total)`);
      } catch (e) {
        log(`WARN: failed #${i + 1}: ${e?.message || e}`);
      } finally {
        finished++;
        setProgress((finished / posts.length) * 80);
        setStatus(`ZIP collecting... ${finished}/${posts.length} (success ~${exported})`);
      }
    }, cfg.concurrency);

    if (cancelled) return;

    const totalSizeKB = Math.round(collectedFiles.reduce((sum, f) => sum + f.content.length, 0) / 1024);
    log(`=== Collection complete: ${collectedFiles.length} files ===`);
    log(`Total content size: ~${totalSizeKB} KB`);

    if (collectedFiles.length === 0) {
      setStatus("No files collected. Nothing to export.");
      return;
    }

    setStatus("Building ZIP (native JS, no JSZip)...");
    setProgress(82);
    log(`Starting native ZIP generation (${collectedFiles.length} files)...`);

    const startTime = Date.now();

    // 使用纯 JS 生成 ZIP，带进度回调
    const zipBlob = createZipBlob(collectedFiles, (current, total, filename) => {
      const pct = 80 + (current / total) * 18;
      setProgress(pct);
      setStatus(`ZIP: ${current}/${total} | ${filename}`);

      if (current % 5 === 0 || current === total) {
        log(`ZIP file: ${current}/${total} - ${filename}`);
      }
    });

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    log(`ZIP generation completed in ${totalTime}s`);

    if (cancelled) return;

    const zipName = `${FILE_PREFIX}.zip`;
    const zipSizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
    downloadBlob(zipName, zipBlob);
    log(`Downloaded: ${zipName} (${exported} posts, ${zipSizeMB} MB)`);
    setProgress(100);
    setStatus(`Done (zip). Exported ~${exported}/${posts.length} posts. Size: ${zipSizeMB} MB`);
    log("DONE (zip).");
  }

})();
