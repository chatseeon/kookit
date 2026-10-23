import ComicRender from "./ComicRender";
import EpubRender from "./EpubRender";
import GeneralParser from "../utils/generalParser";
import {
  applyResolvedRevertDirection,
  getScrollLeftForLogical,
} from "../utils/layoutUtil";
import {
  createPDFIframe,
  handleScrollPDFPosition,
  isPDFScrolledIntoView,
} from "../utils/pdfUtil";
import {
  alignPageContentToCenter,
  getPageGap,
  setTightDoublePage,
} from "../utils/pageGapUtil";
import {
  findZipEntry,
  getZipImageSize,
  readZipDirectory,
  ZipEntryInfo,
} from "../utils/zipImageUtil";
declare var window: any;

// 每个 spine 项就是一页，复用漫画的多 iframe 分页
const FIXED_PAGE_ATTR = "data-kookit-fixed-page";
// 用空白槽位对齐 page-spread 与 RTL 封面
const BLANK_SLOT_MARK = "pdf-container-blank-";

const injectFixedPageStyle = (iframe: HTMLIFrameElement) => {
  try {
    const subDoc = iframe.contentDocument;
    if (!subDoc || !subDoc.documentElement) return;
    if (subDoc.getElementById("kookit-fixed-page-style")) return;
    const style = subDoc.createElement("style");
    style.id = "kookit-fixed-page-style";
    style.textContent =
      "html,body{height:100%!important;margin:0!important;padding:0!important;}" +
      "body{overflow:hidden!important;}" +
      "img,svg{max-width:100%!important;max-height:100vh!important;object-fit:contain;}";
    (subDoc.head || subDoc.documentElement).appendChild(style);
    // 单图页垂直居中；多元素页面保留原布局，避免破坏图文混排版式
    const images = subDoc.body?.querySelectorAll("img,svg") || [];
    if (images.length === 1 && !subDoc.body.textContent?.trim()) {
      subDoc.body.style.display = "flex";
      subDoc.body.style.alignItems = "center";
      subDoc.body.style.justifyContent = "center";
    }
    alignPageContentToCenter(iframe);
  } catch (error) {}
};

class FixedEpubRender extends ComicRender {
  config: any;
  // 槽位到页码，-1 为空白位，-2 为横版页占位
  slotPageMap: number[] = [];
  pageSlotMap: number[] = [];
  private landscapePages = new Set<number>();
  private pageAspectRatios: (number | null)[] = [];
  private templateAspectRatio = 0;
  constructor(epubBuffer: ArrayBuffer, config: any) {
    super(epubBuffer, config);
    this.config = config;
  }
  shouldTightDoublePage() {
    return (
      this.readerMode === "double" && this.config?.isTightDoublePage === "yes"
    );
  }
  isMangaLayout() {
    return true;
  }
  // 读取图片头部宽高，识别横版跨页
  private async detectLandscapePages() {
    this.landscapePages.clear();
    this.pageAspectRatios = [];
    this.templateAspectRatio = 0;
    if (
      this.config?.isLandscapeSpreadAlone !== "yes" ||
      this.readerMode !== "double" ||
      !this.chapterDocList.length
    ) {
      return;
    }
    let zipEntries: Map<string, ZipEntryInfo>;
    try {
      zipEntries = readZipDirectory(this.comicBuffer);
    } catch (error) {
      return;
    }
    if (!zipEntries.size) return;
    // 4 路并发，避免逐页解压拖慢首屏
    const count = this.chapterDocList.length;
    const pageRatios: (number | null)[] = new Array(count).fill(null);
    let cursor = 0;
    const detectOne = async () => {
      while (true) {
        const i = cursor++;
        if (i >= count) return;
        try {
          const section = this.book?.sections?.[i];
          if (section?.createDocument) {
            const doc = await section.createDocument();
            const href = this.getDocumentImageHref(doc);
            let ratio: number | null = null;
            if (href) {
              const resolved = section.resolveHref
                ? section.resolveHref(href)
                : href;
              const entry = findZipEntry(zipEntries, resolved);
              const size = entry
                ? getZipImageSize(this.comicBuffer, entry)
                : null;
              if (size) ratio = size.width / size.height;
            }
            if (!ratio) ratio = this.getDocumentAspectRatio(doc);
            pageRatios[i] = ratio;
          }
        } catch (error) {
          // 单页失败不影响其他页
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, count) }, () => detectOne())
    );
    const ratios: number[] = [];
    this.pageAspectRatios = pageRatios;
    pageRatios.forEach((ratio) => {
      if (ratio && ratio > 0) ratios.push(ratio);
    });
    if (!ratios.length) return;
    // 以中位数为基准，明显更宽的判为横版页
    const sorted = ratios.slice().sort((a, b) => a - b);
    this.templateAspectRatio = sorted[Math.floor(sorted.length / 2)];
    for (let i = 0; i < this.pageAspectRatios.length; i++) {
      const ratio = this.pageAspectRatios[i];
      if (ratio && ratio > 1.05 && ratio > this.templateAspectRatio * 1.25) {
        this.landscapePages.add(i);
      }
    }
  }
  private getDocumentImageHref(doc: Document): string {
    try {
      const images = doc.querySelectorAll("img, image");
      if (images.length !== 1) return "";
      const image = images[0];
      return (
        image.getAttribute("src") ||
        image.getAttribute("xlink:href") ||
        image.getAttribute("href") ||
        image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
        ""
      );
    } catch (error) {
      return "";
    }
  }
  private getDocumentAspectRatio(doc: Document): number | null {
    try {
      const metas = Array.from(doc.querySelectorAll("meta"));
      for (const meta of metas) {
        const name = (meta.getAttribute("name") || "").toLowerCase();
        const content = meta.getAttribute("content") || "";
        if (name === "viewport") {
          const width = /width\s*=\s*([\d.]+)/i.exec(content);
          const height = /height\s*=\s*([\d.]+)/i.exec(content);
          if (width && height && parseFloat(height[1]) > 0) {
            return parseFloat(width[1]) / parseFloat(height[1]);
          }
        } else if (name === "original-resolution") {
          const match = /([\d.]+)\s*[x×]\s*([\d.]+)/i.exec(content);
          if (match && parseFloat(match[2]) > 0) {
            return parseFloat(match[1]) / parseFloat(match[2]);
          }
        }
      }
    } catch (error) {}
    return null;
  }
  // RTL 封面默认单页，page-spread 显式对齐
  private buildPageSlots() {
    this.slotPageMap = [];
    this.pageSlotMap = [];
    if (this.readerMode !== "double") return;
    const rtl = this.revertDirection === "yes";
    for (let i = 0; i < this.chapterDocList.length; i++) {
      const spread = this.book?.sections?.[i]?.pageSpread;
      // center 是跨页插图，独占一屏（复用横版页的 -2 容器）
      if (spread === "center") {
        if (this.slotPageMap.length % 2 !== 0) {
          this.slotPageMap.push(-1);
        }
        this.slotPageMap.push(i, -2);
        this.landscapePages.add(i);
        continue;
      }
      // 横版页独占一屏，下一槽位留空
      if (this.landscapePages.has(i)) {
        if (this.slotPageMap.length % 2 !== 0) {
          this.slotPageMap.push(-1);
        }
        this.slotPageMap.push(i, -2);
        continue;
      }
      // 封面单独一屏：RTL 居右，LTR 居左
      if (i === 0 && !spread) {
        if (rtl) {
          this.slotPageMap.push(0, -1);
        } else {
          this.slotPageMap.push(-1, 0);
        }
        continue;
      }
      if (spread === "left" || spread === "right") {
        // RTL 偶数列在右，LTR 在左
        const desired = rtl
          ? spread === "right"
            ? 0
            : 1
          : spread === "left"
            ? 0
            : 1;
        if (this.slotPageMap.length % 2 !== desired) {
          this.slotPageMap.push(-1);
        }
      }
      this.slotPageMap.push(i);
    }
    this.slotPageMap.forEach((page, slot) => {
      if (page >= 0) this.pageSlotMap[page] = slot;
    });
  }
  private hasBlankSlots() {
    return this.slotPageMap.some((page) => page < 0);
  }
  private getSpreadStart(pageIndex: number) {
    if (this.readerMode !== "double" || !this.pageSlotMap.length) {
      if (this.readerMode === "double" && pageIndex % 2 === 1) {
        return pageIndex - 1;
      }
      return pageIndex;
    }
    const slot = this.pageSlotMap[pageIndex];
    if (slot === undefined) return pageIndex;
    const startSlot = slot - (slot % 2);
    const startPage = this.slotPageMap[startSlot];
    return startPage >= 0 ? startPage : pageIndex;
  }
  async getTemplateAspectRatio() {
    if (this.templateAspectRatio > 0) return this.templateAspectRatio;
    return super.getTemplateAspectRatio();
  }
  async createComicContainer(doc: Document) {
    setTightDoublePage(
      doc,
      this.readerMode === "double" && this.shouldTightDoublePage()
    );
    if (this.readerMode === "double") {
      await this.detectLandscapePages();
    }
    this.buildPageSlots();
    if (this.readerMode !== "double" || !this.hasBlankSlots()) {
      return super.createComicContainer(doc);
    }
    const fragment = doc.createDocumentFragment();
    const aspectRatio = await this.getTemplateAspectRatio();
    const gap = getPageGap(doc.body.clientWidth, doc);
    const pageWidth = (doc.body.clientWidth - gap) / 2;
    const containerHeight = Math.min(
      pageWidth / aspectRatio,
      this.element.clientHeight
    );
    for (let slot = 0; slot < this.slotPageMap.length; slot++) {
      const pageIndex = this.slotPageMap[slot];
      const isLandscape =
        pageIndex >= 0 && this.landscapePages.has(pageIndex);
      const isBlank = pageIndex < 0;
      const iframeContainer = doc.createElement("div");
      iframeContainer.style.position = "relative";
      iframeContainer.style.width = "100%";
      iframeContainer.id =
        pageIndex >= 0
          ? "pdf-container-" + pageIndex
          : BLANK_SLOT_MARK + slot;
      iframeContainer.className = "pdf-container";
      if (isLandscape) {
        iframeContainer.style.width = doc.body.clientWidth + "px";
        // handlePDFLayout 尚未执行，取外层可视高度
        iframeContainer.style.paddingTop =
          (this.element.clientHeight || doc.documentElement.clientHeight) + "px";
        iframeContainer.style.marginBottom = "0px";
      } else if (isBlank) {
        // 空白槽需撑满一屏，避免后续页被排入
        iframeContainer.style.paddingTop =
          (this.element.clientHeight || doc.documentElement.clientHeight) + "px";
        iframeContainer.style.marginBottom = "0px";
      } else {
        iframeContainer.style.paddingTop = containerHeight + "px";
        iframeContainer.style.marginBottom = "2%";
      }
      iframeContainer.style.overflow = "hidden";
      iframeContainer.style.breakInside = "avoid";
      // 每屏固定分列，避免页面被挤进同一列
      iframeContainer.style.breakAfter =
        slot < this.slotPageMap.length - 1 ? "column" : "auto";
      fragment.appendChild(iframeContainer);
    }
    (doc.body || doc.documentElement).appendChild(fragment);
  }
  // 有补位槽时不能按 pageIndex / 2 计算
  private async scrollToPage(pageIndex: number) {
    const doc = this.getDocument();
    if (!doc) return;
    if (this.readerMode !== "double" || !this.pageSlotMap.length) {
      await handleScrollPDFPosition(
        this.getSpreadStart(pageIndex),
        this.readerMode,
        doc
      );
      return;
    }
    const slot = this.pageSlotMap[pageIndex] ?? 0;
    const viewIndex = Math.floor(slot / 2);
    const gap = getPageGap(doc.body.clientWidth, doc);
    const stride = doc.body.clientWidth + gap;
    doc.body.scrollTo(getScrollLeftForLogical(doc.body, viewIndex * stride), 0);
  }
  async parse() {
    if (this.book) return;
    const epubRender = new EpubRender(this.comicBuffer, this.config);
    await epubRender.parse();
    this.book = epubRender.book;
    this.revertDirection = applyResolvedRevertDirection(
      this.revertDirectionConfig,
      this.book?.dir
    );
  }
  async getMetadata() {
    if (!this.book) {
      await this.parse();
    }
    return await new GeneralParser(this.book).getMetadata();
  }
  async handleComicScrollEvent(doc: Document) {
    if (!this.hasBlankSlots()) return super.handleComicScrollEvent(doc);
    const subContainers = doc.querySelectorAll(".pdf-container");
    for (let index = 0; index < subContainers.length; index++) {
      const subContainer = subContainers[index] as HTMLElement;
      const id = subContainer.getAttribute("id") || "";
      if (id.indexOf("-blank-") > -1) continue;
      const pageIndex = parseInt(id.split("-").reverse()[0]);
      if (!Number.isFinite(pageIndex)) continue;
      if (
        isPDFScrolledIntoView(
          this.element,
          subContainer,
          this.readerMode,
          doc
        )
      ) {
        await this.renderComicPage(pageIndex);
      }
    }
  }
  // 空白槽没有页码，跳过
  handleComicRecordByContainer(
    subContainer: HTMLElement,
    normalizeSpreadStart = false
  ) {
    if (subContainer.id && subContainer.id.indexOf("-blank-") > -1) return;
    super.handleComicRecordByContainer(subContainer, normalizeSpreadStart);
  }
  async handleComicRecord(doc: Document) {
    if (!this.hasBlankSlots()) return super.handleComicRecord(doc);
    const subContainers = doc.querySelectorAll(".pdf-container");
    for (let index = 0; index < subContainers.length; index++) {
      const subContainer = subContainers[index] as HTMLElement;
      if (subContainer.id.indexOf("-blank-") > -1) continue;
      if (
        isPDFScrolledIntoView(
          this.element,
          subContainer,
          this.readerMode,
          doc
        )
      ) {
        this.handleComicRecordByContainer(subContainer);
        break;
      }
    }
  }
  // 槽位可能因补位偏移，不能按页码奇偶取图
  async getImageList(chapterDocIndex?: number): Promise<string[]> {
    if (this.readerMode !== "double" || !this.pageSlotMap.length) {
      return super.getImageList(chapterDocIndex);
    }
    let index = chapterDocIndex;
    if (index === undefined || index === null) {
      index = parseInt(this.tempLocation.chapterDocIndex || "0");
      if (isNaN(index)) index = 0;
    }
    const start = this.getSpreadStart(index);
    const slot = this.pageSlotMap[start];
    if (slot === undefined) return super.getImageList(chapterDocIndex);
    // 所选页可能在本屏右槽，按整屏取图
    const firstSlot = slot - (slot % 2);
    const pages: number[] = [];
    for (let offset = 0; offset < 2; offset++) {
      const page = this.slotPageMap[firstSlot + offset];
      if (page !== undefined && page >= 0 && pages.indexOf(page) === -1) {
        pages.push(page);
      }
    }
    if (!pages.length) return super.getImageList(chapterDocIndex);
    const urls: string[] = [];
    for (const page of pages) {
      const url = await this.getComicImageUrl(page);
      if (url) urls.push(url);
    }
    return urls;
  }
  async goToChapter(
    chapterDocIndex: any,
    chapterHref: string,
    chapterTitle: string
  ) {
    if (this.readerMode !== "double" || !this.slotPageMap.length) {
      return super.goToChapter(chapterDocIndex, chapterHref, chapterTitle);
    }
    let index = parseInt(chapterDocIndex);
    if (!Number.isFinite(index)) index = 0;
    index = this.getSpreadStart(index);
    const doc = this.getDocument();
    const iframe = this.getIframe();
    if (!doc || !iframe) return;
    await this.renderComicPage(index);
    await this.scrollToPage(index);
    await this.recordByChapter(index);
  }
  async goToPosition(bookLocationStr: string) {
    if (this.readerMode !== "double" || !this.slotPageMap.length) {
      return super.goToPosition(bookLocationStr);
    }
    const doc = this.getDocument();
    const iframe = this.getIframe();
    if (!doc || !iframe) return;
    const bookLocation = JSON.parse(bookLocationStr);
    if (bookLocation.chapterDocIndex === undefined) {
      bookLocation.chapterDocIndex = 0;
    }
    let index = parseInt(bookLocation.chapterDocIndex);
    if (!Number.isFinite(index)) index = 0;
    const savedIndex = index;
    index = this.getSpreadStart(index);
    this.tempLocation = {
      text: bookLocation.text,
      chapterTitle: bookLocation.chapterTitle,
      chapterDocIndex: index + "",
      chapterHref: bookLocation.chapterHref,
      count: bookLocation.count,
      page: bookLocation.page,
      percentage: bookLocation.percentage,
    };
    // 归一化后 index 不变，需同步标题/链接/进度
    if (index !== savedIndex && this.chapterDocList[index]) {
      this.tempLocation.chapterHref = this.chapterDocList[index].href;
      this.tempLocation.chapterTitle = this.chapterDocList[index].label;
      this.tempLocation.percentage =
        this.chapterDocList.length === 1
          ? "1"
          : index / (this.chapterDocList.length - 1) + "";
    }
    await this.renderComicPage(index);
    await this.scrollToPage(index);
    await this.recordByChapter(index);
    this.addPageAnimation();
  }
  async handleRenderComicChapter(chapterDocIndex: number) {
    if (
      !Number.isFinite(chapterDocIndex) ||
      chapterDocIndex < 0 ||
      chapterDocIndex >= this.chapterDocList.length
    ) {
      return;
    }
    const doc = this.getDocument();
    if (!doc) return;
    let subIframe: HTMLIFrameElement = doc.getElementById(
      "pdf-iframe-" + chapterDocIndex
    ) as HTMLIFrameElement;
    if (!subIframe) {
      subIframe = createPDFIframe(chapterDocIndex, doc) as HTMLIFrameElement;
    }
    if (!subIframe) return;
    if (subIframe.getAttribute(FIXED_PAGE_ATTR)) return;
    const url = await this.chapterDocList[chapterDocIndex].text.load();
    if (!url) return;
    subIframe.setAttribute(FIXED_PAGE_ATTR, "loading");
    if (this.isAllowScript !== "yes") {
      // 默认不执行书内脚本
      subIframe.setAttribute("sandbox", "allow-same-origin");
    }
    subIframe.onload = () => {
      const loadedDoc = subIframe.contentDocument;
      // 加载失败时清掉标记，下次滚动可重试
      if (!loadedDoc || loadedDoc.URL !== url) {
        subIframe.removeAttribute(FIXED_PAGE_ATTR);
        return;
      }
      injectFixedPageStyle(subIframe);
      subIframe.setAttribute(FIXED_PAGE_ATTR, "yes");
      this.trigger("rendered", [chapterDocIndex] as any);
    };
    subIframe.src = url;
  }
  async handleUnloadComicChapter(chapterDocIndex: number) {
    if (
      !Number.isFinite(chapterDocIndex) ||
      chapterDocIndex < 0 ||
      chapterDocIndex >= this.chapterDocList.length
    ) {
      return;
    }
    const doc = this.getDocument();
    const subIframe = doc?.getElementById(
      "pdf-iframe-" + chapterDocIndex
    ) as HTMLIFrameElement | null;
    if (!subIframe) return;
    if (!subIframe.getAttribute(FIXED_PAGE_ATTR)) return;
    subIframe.removeAttribute(FIXED_PAGE_ATTR);
    subIframe.onload = null;
    subIframe.src = "about:blank";
    await this.chapterDocList[chapterDocIndex].text.unload();
  }
}

export default FixedEpubRender;
