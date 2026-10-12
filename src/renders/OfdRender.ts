import ComicRender from "./ComicRender";
import { createPDFIframe } from "../utils/pdfUtil.js";
import {
  LiteOfd,
  OfdRender as OfdPageRenderer,
  parser as ofdParser,
  OFD_KEY as ofdKeys,
  rendererConfig,
} from "liteofd";
declare var window: any;

const DEFAULT_PAGE_BOX = { width: 210, height: 297 };
// 与 liteofd 内部的 MaxScale 保持一致（超过 5 会被库截断）
const MAX_RENDER_SCALE = 5;
const PAGE_RENDER_TIMEOUT = 6000;
const COVER_WIDTH = 640;

const clampScale = (scale: number): number => {
  if (!isFinite(scale) || scale < 1) {
    return 1;
  }
  return Math.min(scale, MAX_RENDER_SCALE);
};

// liteofd 的页面内容在 setTimeout 中异步绘制且没有完成回调，
// 用 16×16 缩绘指纹轮询：非空且连续两次一致视为绘制完成（超时兜底放行）
const waitForPageStable = (
  pageEl: HTMLElement,
  timeout: number
): Promise<void> =>
  new Promise((resolve) => {
    const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas || !canvas.width || !canvas.height) {
      resolve();
      return;
    }
    const sample = document.createElement("canvas");
    sample.width = 16;
    sample.height = 16;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      resolve();
      return;
    }
    let lastFingerprint = "";
    let stableCount = 0;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      let fingerprint = "";
      try {
        ctx.clearRect(0, 0, 16, 16);
        ctx.drawImage(canvas, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let hash = 2166136261;
        let visible = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] > 8) visible++;
          hash = ((hash ^ data[index]) * 16777619) >>> 0;
          hash = ((hash ^ data[index + 3]) * 16777619) >>> 0;
        }
        fingerprint = visible > 0 ? hash.toString(36) : "";
      } catch (error) {
        fingerprint = "";
      }
      stableCount =
        fingerprint && fingerprint === lastFingerprint ? stableCount + 1 : 0;
      lastFingerprint = fingerprint;
      if (stableCount >= 1 || Date.now() - startedAt > timeout) {
        clearInterval(timer);
        resolve();
      }
    }, 120);
  });

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });

// 解析/渲染期间抑制 liteofd 内部大量的 console.log/info/warn：
// 移动端 kookit 会把 console.* 转发 RN WebView（postMessage），日志风暴会
// 挤占桥消息；计数式切换保证并发调用时还原正确，console.error 不抑制
let consoleSilenceDepth = 0;
let silencedConsole: { log: any; info: any; warn: any } | null = null;
const silenceConsole = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  consoleSilenceDepth++;
  if (consoleSilenceDepth === 1) {
    silencedConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
    };
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }
  try {
    return await fn();
  } finally {
    consoleSilenceDepth--;
    if (consoleSilenceDepth === 0 && silencedConsole) {
      console.log = silencedConsole.log;
      console.info = silencedConsole.info;
      console.warn = silencedConsole.warn;
      silencedConsole = null;
    }
  }
};

// OFD 是固定版式文档，逐页由 liteofd 渲染为 canvas 后挂进独立 iframe，
// 分页/懒加载/卸载沿用漫画（ComicRender）的多 iframe 结构。
// 页面先在主文档的游离容器里完成绘制、再挂进 iframe：canvas 文字按绘制时
// 所在文档的字体集解析，这样才能用上主文档里注册的内嵌字体（挂载后绘制会
// 退化为 iframe 内的系统字体）
class OfdRender extends ComicRender {
  liteOfd: any = null;
  ofdDocument: any = null;
  private renderingPages: Map<number, Promise<void>> = new Map();
  private coverBlob: Blob | null = null;

  async parse() {
    try {
      if (this.ofdDocument) return;
      if (typeof LiteOfd !== "function") {
        throw new Error("liteofd module is not available");
      }
      // 固定 canvas 渲染模式：每页一个 canvas，绘制完成后再挂载
      if (rendererConfig && typeof rendererConfig.setRendererType === "function") {
        rendererConfig.setRendererType("canvas");
      }
      const liteOfd = new LiteOfd();
      await silenceConsole(() => liteOfd.parse(this.comicBuffer));
      if (typeof liteOfd.toggleRenderTextLayer === "function") {
        // 关闭 DOM 文本选择层：其样式依赖 liteofd 未随包发布的 css
        liteOfd.toggleRenderTextLayer(false);
      }
      this.liteOfd = liteOfd;
      this.ofdDocument = liteOfd.getOfdDocument();
      const pageCount = this.ofdDocument?.pages?.length || 0;
      if (pageCount === 0) {
        throw new Error("Invalid OFD file: no pages found");
      }
      this.book = {
        metadata: { title: this.filePath || "document.ofd" },
        rendition: { layout: "pre-paginated" },
        // 页面渲染由 handleRenderComicChapter 覆写后直接驱动，section 的
        // load/unload 仅保留给 GeneralParser 组装 chapterDocList 使用
        sections: Array.from({ length: pageCount }, (_, index) => ({
          id: "page-" + index,
          label: "Page " + (index + 1),
          href: "page-" + index,
          load: async () => "",
          unload: async () => {},
        })),
        toc: Array.from({ length: pageCount }, (_, index) => ({
          label: "Page " + (index + 1),
          href: "page-" + index,
        })),
        getCover: async () => {
          const cover = await this.getCoverBlob();
          return cover ? cover : new Blob([new ArrayBuffer(0)]);
        },
        resolveHref: (href: string) => ({ index: parsePageHref(href) }),
        resolveHrefIndex: (href: string) => ({ index: parsePageHref(href) }),
        splitTOCHref: (href: string) => [href, null],
        getTOCFragment: (doc: Document) => doc.documentElement,
      } as any;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  // 页面尺寸来自页面 PhysicalBox（单位 mm），缺失时回退 document 级配置
  private getPhysicalBox(
    pageIndex: number
  ): { width: number; height: number } | null {
    const ofdDocument = this.ofdDocument;
    if (!ofdDocument) return null;
    const pageData = ofdDocument.pages && ofdDocument.pages[pageIndex];
    let boxNode = pageData
      ? ofdParser.findValueByTagName?.(pageData, ofdKeys.PhysicalBox)
      : null;
    if (!boxNode && ofdDocument.documentData) {
      boxNode = ofdParser.findValueByTagName?.(
        ofdDocument.documentData,
        ofdKeys.PhysicalBox
      );
    }
    const values = String((boxNode && boxNode.value) || "")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (
      values.length < 4 ||
      !isFinite(values[2]) ||
      !isFinite(values[3]) ||
      values[2] <= 0 ||
      values[3] <= 0
    ) {
      return null;
    }
    return { width: values[2], height: values[3] };
  }

  // 在主文档的游离容器里渲染单页并等待绘制完成，返回页面元素（含 canvas）
  private async renderPageElement(
    pageIndex: number,
    scale: number
  ): Promise<HTMLElement> {
    const ofdDocument = this.ofdDocument;
    if (!ofdDocument) {
      throw new Error("OFD document not parsed");
    }
    const container = document.createElement("div");
    let pageEl: HTMLElement | null = null;
    // 绘制在 setTimeout 中异步进行，抑制窗口需要覆盖整个绘制 + 等待稳定阶段
    await silenceConsole(async () => {
      new OfdPageRenderer(ofdDocument).renderOfdWithPageIndexWithScale(
        pageIndex,
        container,
        "background-color: #ffffff;",
        scale
      );
      pageEl = (container.querySelector(".page-container") ||
        container.firstElementChild) as HTMLElement | null;
      if (pageEl) {
        await waitForPageStable(pageEl, PAGE_RENDER_TIMEOUT);
      }
    });
    if (!pageEl) {
      throw new Error("Failed to render OFD page element");
    }
    return pageEl;
  }

  async getCoverBlob(): Promise<Blob | null> {
    if (!this.coverBlob) {
      try {
        if (!this.ofdDocument) {
          await this.parse();
        }
        const box = this.getPhysicalBox(0) || DEFAULT_PAGE_BOX;
        const pageEl = await this.renderPageElement(
          0,
          clampScale(COVER_WIDTH / box.width)
        );
        const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement | null;
        if (!canvas || !canvas.width || !canvas.height) {
          return null;
        }
        this.coverBlob = await canvasToBlob(canvas);
      } catch (error) {
        console.error(error);
        return null;
      }
    }
    return this.coverBlob;
  }

  async getTemplateAspectRatio() {
    const box = this.getPhysicalBox(0);
    if (box && box.height > 0) {
      return box.width / box.height;
    }
    return 0.75;
  }

  async handleRenderComicChapter(chapterDocIndex: number) {
    if (chapterDocIndex >= this.chapterDocList.length || chapterDocIndex < 0) {
      return;
    }
    let doc: any = this.getDocument();
    if (!doc) return;
    let subIframe: any = doc.getElementById("pdf-iframe-" + chapterDocIndex);
    if (!subIframe) {
      subIframe = createPDFIframe(chapterDocIndex, doc);
    }
    let subDoc: any = subIframe?.contentDocument;
    if (!subDoc) return;
    if (subDoc.body.innerHTML) {
      return;
    }
    const existing = this.renderingPages.get(chapterDocIndex);
    if (existing) {
      return existing;
    }
    const task = this.renderPage(chapterDocIndex, subIframe, subDoc);
    this.renderingPages.set(chapterDocIndex, task);
    try {
      await task;
    } finally {
      this.renderingPages.delete(chapterDocIndex);
    }
  }

  private async renderPage(
    chapterDocIndex: number,
    subIframe: any,
    subDoc: any
  ) {
    try {
      const box = this.getPhysicalBox(chapterDocIndex) || DEFAULT_PAGE_BOX;
      const viewW = subIframe.clientWidth || window.innerWidth || 800;
      const viewH = subIframe.clientHeight || window.innerHeight || 1000;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = clampScale((viewW * dpr) / box.width);
      const pageEl = await this.renderPageElement(chapterDocIndex, scale);
      if (subDoc.body.innerHTML) return;
      // 库自带的文本/注释层依赖未随包发布的 css，移除后只保留 canvas 内容层
      pageEl
        .querySelectorAll(".annotationEditorLayer,.annotionLayer,.textLayer")
        .forEach((el) => el.remove());
      subDoc.body.style.margin = "0";
      subDoc.body.style.height = "100%";
      subDoc.body.style.overflow = "hidden";
      subDoc.documentElement.style.height = "100%";
      const wrapper = subDoc.createElement("div");
      wrapper.setAttribute("data-ofd-page", "1");
      wrapper.style.cssText =
        "position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;background:#ffffff;";
      subDoc.body.appendChild(wrapper);
      // 跨文档 appendChild 自动 adopt；canvas 已在主文档绘制完成，位图保留
      wrapper.appendChild(pageEl);
      // 页面在 iframe 内完成布局后按实际尺寸等比适配（通常宽高比与容器一致）
      const pageW = pageEl.offsetWidth || box.width * scale;
      const pageH = pageEl.offsetHeight || box.height * scale;
      const fit = Math.min(viewW / pageW, viewH / pageH);
      pageEl.setAttribute(
        "style",
        (pageEl.getAttribute("style") || "") +
          `;position:absolute;left:${Math.max(0, (viewW - pageW * fit) / 2)}px;` +
          `top:${Math.max(0, (viewH - pageH * fit) / 2)}px;` +
          `transform-origin:top left;transform:scale(${fit});`
      );
      this.trigger("rendered", [chapterDocIndex] as any);
    } catch (error) {
      console.error(error);
      if (subDoc && subDoc.body && !subDoc.body.innerHTML) {
        subDoc.body.textContent = "Failed to render OFD page";
      }
    }
  }

  async handleUnloadComicChapter(chapterDocIndex: number) {
    if (chapterDocIndex >= this.chapterDocList.length || chapterDocIndex < 0) {
      return;
    }
    let subDoc = this.getSubDocument(chapterDocIndex);
    if (subDoc && subDoc.body.innerHTML === "") {
      return;
    }
    if (subDoc) {
      // canvas 随 DOM 断开由浏览器回收，无需额外释放
      subDoc.body.innerHTML = "";
    }
  }

  // scroll 模式下只预取下一页，避免同时保留过多高分辨率 canvas
  async renderComicPage(chapterDocIndex: number) {
    if (chapterDocIndex >= this.chapterDocList.length || chapterDocIndex < 0) {
      return;
    }
    if (chapterDocIndex > 2) {
      await this.handleUnloadComicChapter(chapterDocIndex - 3);
    }
    await this.handleRenderComicChapter(chapterDocIndex);
    if (this.platform === "ios") {
      return;
    }
    this.handleRenderComicChapter(chapterDocIndex + 1);
  }

  // 页面由解析结果实时渲染，无静态 HTML 可缓存，返回空表示不支持预缓存
  async preCache() {
    return "";
  }

  // 关闭书籍时释放解析结果；再次 renderTo 会重新 parse
  removeContent() {
    super.removeContent();
    this.liteOfd = null;
    this.ofdDocument = null;
    this.coverBlob = null;
    this.renderingPages.clear();
    this.book = "";
  }

  async getMetadata() {
    return new Promise<any>(async (resolve, reject) => {
      try {
        if (!this.ofdDocument) {
          await this.parse();
        }
        const cover = await this.getCoverBlob();
        const name = this.filePath || "document.ofd";
        if (!cover) {
          resolve({ name: name, cover: "" });
          return;
        }
        var reader = new FileReader();
        reader.readAsDataURL(cover);
        reader.onloadend = () => {
          resolve({ name: name, cover: reader.result });
        };
      } catch (error) {
        console.error(error);
        reject(error);
      }
    });
  }

  // 文本索引来自解析模型（TextCode 拼接），未渲染的页也能检索；每页取首个命中
  async doSearch(keyword: string): Promise<any[]> {
    if (!this.ofdDocument || !keyword) return [];
    try {
      const pages = this.ofdDocument.pages || [];
      const results: any[] = [];
      const count = this.chapterDocList.length || pages.length || 1;
      const lowerKeyword = keyword.toLowerCase();
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        let text = "";
        try {
          // getContentText 内部逐节点 console.log，移动端需要一并抑制
          text =
            (await silenceConsole(
              () => this.ofdDocument.getContentText(pageIndex + 1) || ""
            )) || "";
        } catch (error) {
          console.error(error);
          continue;
        }
        const position = text.toLowerCase().indexOf(lowerKeyword);
        if (position === -1) continue;
        const excerpt = text
          .substr(Math.max(0, position - 20), keyword.length + 40)
          .trim();
        results.push({
          excerpt: excerpt,
          cfi: JSON.stringify({
            text: excerpt,
            chapterTitle:
              this.chapterDocList[pageIndex]?.label ||
              "Page " + (pageIndex + 1),
            chapterDocIndex: pageIndex,
            chapterHref: this.chapterDocList[pageIndex]?.href || "",
            count: "search",
            percentage: pageIndex / count,
            keyword: keyword,
          }),
        });
      }
      return results;
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  // 朗读/文本提取：取当前页解析出的 TextCode 文本
  async getCurrentPageText(): Promise<string[]> {
    const chapterDocIndex = parseInt(this.tempLocation.chapterDocIndex || "0");
    if (isNaN(chapterDocIndex) || chapterDocIndex < 0) return [];
    const pages = this.ofdDocument?.pages;
    if (!pages || chapterDocIndex >= pages.length) return [];
    try {
      const text = await silenceConsole(
        () => this.ofdDocument.getContentText(chapterDocIndex + 1)
      );
      return text ? [text] : [];
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async visibleText(): Promise<any[]> {
    return await this.getCurrentPageText();
  }

  async audioText(): Promise<any[]> {
    return await this.getCurrentPageText();
  }

  async getRestAudioText(_count: number) {
    return [];
  }

  async chapterText() {
    const texts = await this.getCurrentPageText();
    return texts.length > 0 ? texts[0] : "";
  }

  async getImageList(_chapterDocIndex?: number): Promise<string[]> {
    return [];
  }
}

const parsePageHref = (href: string): number => {
  const match = href.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
};

export default OfdRender;
