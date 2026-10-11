import ComicRender from "./ComicRender";
import { createPDFIframe } from "../utils/pdfUtil.js";
import {
  DjvuFile,
  DjvuOutlineNode,
  DjvuPageDecoder,
  DjvuPageImage,
} from "../libs/djvu";

// DjVu 是固定版式文档（MRC：掩码 + 背景 + 前景），逐页解码合成为位图后
// 绘制到页面 iframe 内的 canvas，分页/懒加载/卸载沿用漫画（ComicRender）的
// 多 iframe 结构；解码按 chunk 分片进行并让出主线程，先出低质量预览再精修。
class DjvuRender extends ComicRender {
  djvu: DjvuFile | null = null;
  private renderingPages: Map<number, Promise<void>> = new Map();
  private pageGenerations: Map<number, number> = new Map();
  private coverBlob: Blob | null = null;

  async parse() {
    try {
      if (this.djvu) return;
      const djvu = await DjvuFile.open(this.comicBuffer);
      this.djvu = djvu;
      djvu.applyMetadataFromAnnotations();
      const pageCount = djvu.pageCount;
      const title = djvu.metadata.title || this.filePath || "document.djvu";
      const outline = djvu.getOutline();
      const pageHref = (index: number) => "page-" + index;
      const pageToc = Array.from({ length: pageCount }, (_, index) => ({
        label: "Page " + (index + 1),
        href: pageHref(index),
      }));
      this.book = {
        metadata: {
          title,
          author: djvu.metadata.author,
          description: djvu.metadata.description,
          publisher: djvu.metadata.publisher,
        },
        rendition: { layout: "pre-paginated" },
        // 页面渲染由 handleRenderComicChapter 覆写后直接驱动，section 的
        // load/unload 仅保留给 GeneralParser 组装 chapterDocList 使用
        sections: Array.from({ length: pageCount }, (_, index) => ({
          id: pageHref(index),
          label: "Page " + (index + 1),
          href: pageHref(index),
          load: async () => "",
          unload: async () => {},
        })),
        toc: outline ? this.outlineToToc(outline, pageHref) : pageToc,
        getCover: async () => {
          const cover = await this.getCoverBlob();
          return cover ? cover : new Blob([new ArrayBuffer(0)]);
        },
        resolveHref: (href: string) => ({ index: this.resolvePageIndex(href) }),
        resolveHrefIndex: (href: string) => ({
          index: this.resolvePageIndex(href),
        }),
        splitTOCHref: (href: string) => [href, null],
        getTOCFragment: (doc: Document) => doc.documentElement,
      } as any;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  private outlineToToc(
    nodes: DjvuOutlineNode[],
    pageHref: (index: number) => string
  ): any[] {
    return nodes.map((node) => {
      const index = node.pageIndex >= 0 ? node.pageIndex : 0;
      return {
        label: node.label || "Page " + (index + 1),
        href: pageHref(index),
        subitems:
          node.children.length > 0
            ? this.outlineToToc(node.children, pageHref)
            : undefined,
      };
    });
  }

  private resolvePageIndex(href: string): number {
    if (!href) return 0;
    const pageMatch = href.match(/^page-(\d+)$/);
    if (pageMatch) return parseInt(pageMatch[1], 10);
    if (this.djvu) {
      const index = this.djvu.resolvePageIndex(href);
      if (index >= 0) return index;
    }
    const digits = href.match(/(\d+)/);
    return digits ? Math.max(0, parseInt(digits[1], 10) - 1) : 0;
  }

  async getCoverBlob(): Promise<Blob | null> {
    if (!this.djvu) {
      await this.parse();
    }
    if (this.coverBlob) return this.coverBlob;
    const thumb = this.djvu!.getThumbnailPixmap(0);
    let image: DjvuPageImage | null = null;
    if (thumb) {
      const rgba = new Uint8ClampedArray(thumb.width * thumb.height * 4);
      for (let i = 0; i < thumb.width * thumb.height; i++) {
        rgba[i * 4] = thumb.rgb[i * 3];
        rgba[i * 4 + 1] = thumb.rgb[i * 3 + 1];
        rgba[i * 4 + 2] = thumb.rgb[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      image = { width: thumb.width, height: thumb.height, rotation: 0, rgba };
    } else if (this.djvu!.pageCount > 0) {
      // 没有 TH44 缩略图时渲染首页作为封面
      image = await this.renderPageImage(0);
    }
    if (!image) return null;
    this.coverBlob = await this.imageToBlob(image);
    return this.coverBlob;
  }

  private imageToBlob(image: DjvuPageImage): Promise<Blob | null> {
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
        0,
        0
      );
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  private async renderPageImage(chapterDocIndex: number): Promise<DjvuPageImage | null> {
    const djvu = this.djvu;
    if (!djvu) return null;
    try {
      const page = djvu.getPage(chapterDocIndex);
      const decoder = new DjvuPageDecoder(page, djvu.getData());
      while (!decoder.isDone) {
        await decoder.decodeNext();
      }
      return decoder.composeToRgba();
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  async getTemplateAspectRatio() {
    if (!this.djvu) {
      return 0.75;
    }
    try {
      const info = this.djvu.getPageInfo(0);
      const width = info.rotation % 2 === 1 ? info.height : info.width;
      const height = info.rotation % 2 === 1 ? info.width : info.height;
      const ratio = width / height;
      return ratio > 0 ? ratio : 0.75;
    } catch (error) {
      console.error(error);
      return 0.75;
    }
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
    if (subDoc.body.querySelector("canvas")) {
      return;
    }
    const existing = this.renderingPages.get(chapterDocIndex);
    if (existing) {
      return existing;
    }
    const task = this.renderPage(chapterDocIndex, subDoc);
    this.renderingPages.set(chapterDocIndex, task);
    try {
      await task;
    } finally {
      this.renderingPages.delete(chapterDocIndex);
    }
  }

  private isGenerationCurrent(chapterDocIndex: number, generation: number) {
    return (this.pageGenerations.get(chapterDocIndex) || 0) === generation;
  }

  private async renderPage(chapterDocIndex: number, subDoc: any) {
    const djvu = this.djvu;
    if (!djvu) return;
    const generation = (this.pageGenerations.get(chapterDocIndex) || 0) + 1;
    this.pageGenerations.set(chapterDocIndex, generation);
    try {
      const page = djvu.getPage(chapterDocIndex);
      // 页面骨架：居中 + 比例盒 + canvas + 文本/注释层
      const rotated = page.info.rotation % 2 === 1;
      const displayWidth = rotated ? page.info.height : page.info.width;
      const displayHeight = rotated ? page.info.width : page.info.height;
      const wrapper = subDoc.createElement("div");
      wrapper.style.cssText =
        "width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;";
      const box = subDoc.createElement("div");
      box.style.cssText = `position:relative;width:100%;aspect-ratio:${displayWidth} / ${displayHeight};max-width:100%;max-height:100%;`;
      const canvas = subDoc.createElement("canvas");
      canvas.style.cssText =
        "position:absolute;top:0;left:0;width:100%;height:100%;display:block;";
      box.appendChild(canvas);
      wrapper.appendChild(box);
      subDoc.body.style.margin = "0";
      subDoc.body.style.height = "100%";
      subDoc.documentElement.style.height = "100%";
      if (!subDoc.body.firstChild) {
        subDoc.body.appendChild(wrapper);
      }

      const decoder = new DjvuPageDecoder(page, djvu.getData());
      const isAlive = () =>
        this.isGenerationCurrent(chapterDocIndex, generation) &&
        !!subDoc.body &&
        !!canvas.parentNode;
      let lastPaint = 0;
      let painted = false;
      for (;;) {
        const step = await decoder.decodeNext();
        if (step === null) break;
        if (!isAlive()) return;
        const now = Date.now();
        if (step === "mask" || now - lastPaint >= 80) {
          this.paintPage(canvas, decoder.composeToRgba());
          painted = true;
          lastPaint = now;
          await yieldToMainThread();
        }
      }
      if (!isAlive()) return;
      const image = decoder.composeToRgba();
      if (!painted || image.width !== canvas.width) {
        this.paintPage(canvas, image);
      }
      this.addTextLayer(subDoc, box, chapterDocIndex);
      this.addAnnotationLayer(subDoc, box, chapterDocIndex);
      this.trigger("rendered", [chapterDocIndex] as any);
    } catch (error) {
      console.error(error);
      if (subDoc && subDoc.body && !subDoc.body.querySelector("canvas")) {
        subDoc.body.textContent = "Failed to render DjVu page";
      }
    }
  }

  private paintPage(canvas: HTMLCanvasElement, image: DjvuPageImage) {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
      0,
      0
    );
  }

  // 把未旋转的页面坐标映射到显示坐标（与合成时的旋转保持一致）
  private mapRect(
    x: number,
    y: number,
    width: number,
    height: number,
    pageWidth: number,
    pageHeight: number,
    rotation: number
  ): { x: number; y: number; width: number; height: number } {
    switch ((4 - rotation) & 3) {
      case 1:
        return {
          x: pageHeight - y - height,
          y: x,
          width: height,
          height: width,
        };
      case 2:
        return {
          x: pageWidth - x - width,
          y: pageHeight - y - height,
          width,
          height,
        };
      case 3:
        return {
          x: y,
          y: pageWidth - x - width,
          width: height,
          height: width,
        };
      default:
        return { x, y, width, height };
    }
  }

  // 隐藏文本层：SVG overlay，随容器缩放自动对齐，支持选文/复制
  private addTextLayer(subDoc: any, box: any, chapterDocIndex: number) {
    const djvu = this.djvu;
    if (!djvu || !subDoc.createElementNS) return;
    let zones: any[] = [];
    try {
      zones = djvu.getPageTextZones(chapterDocIndex);
    } catch (error) {
      console.error(error);
      return;
    }
    if (!zones || zones.length === 0) {
      return;
    }
    const flat: any[] = [];
    const walk = (list: any[]) => {
      for (const zone of list) {
        if (zone.children && zone.children.length > 0) walk(zone.children);
        else if (zone.text && zone.text.trim()) flat.push(zone);
      }
    };
    walk(zones);
    if (flat.length === 0) return;
    const info = djvu.getPageInfo(chapterDocIndex);
    const displayWidth = info.rotation % 2 === 1 ? info.height : info.width;
    const displayHeight = info.rotation % 2 === 1 ? info.width : info.height;
    const svg = subDoc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${displayWidth} ${displayHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;";
    for (const zone of flat) {
      const rect = this.mapRect(
        zone.x,
        zone.y,
        zone.width,
        zone.height,
        info.width,
        info.height,
        info.rotation
      );
      const text = subDoc.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(rect.x));
      text.setAttribute("y", String(rect.y + rect.height * 0.8));
      text.setAttribute("font-size", String(Math.max(1, rect.height * 0.8)));
      text.setAttribute("fill", "transparent");
      text.setAttribute("style", "user-select:text;cursor:text;");
      text.textContent = zone.text;
      svg.appendChild(text);
    }
    box.appendChild(svg);
  }

  // 注释层：带 href 属性的透明元素，复用 touchUtil 的链接跳转机制
  private addAnnotationLayer(subDoc: any, box: any, chapterDocIndex: number) {
    const djvu = this.djvu;
    if (!djvu) return;
    let annotations: any[] = [];
    try {
      annotations = djvu.getAnnotations(chapterDocIndex);
    } catch (error) {
      console.error(error);
      return;
    }
    if (!annotations || annotations.length === 0) return;
    const info = djvu.getPageInfo(chapterDocIndex);
    for (const annotation of annotations) {
      if (!annotation.url) continue;
      const shape = annotation.shape;
      const rect = this.mapRect(
        shape.x,
        shape.y,
        Math.max(1, shape.width),
        Math.max(1, shape.height),
        info.width,
        info.height,
        info.rotation
      );
      const link = subDoc.createElement("div");
      link.setAttribute("href", annotation.url);
      if (annotation.comment) link.setAttribute("title", annotation.comment);
      link.style.cssText = `position:absolute;left:${(rect.x / info.width) * 100}%;top:${
        (rect.y / info.height) * 100
      }%;width:${(rect.width / info.width) * 100}%;height:${
        (rect.height / info.height) * 100
      }%;cursor:pointer;background:transparent;`;
      box.appendChild(link);
    }
  }

  async handleUnloadComicChapter(chapterDocIndex: number) {
    if (chapterDocIndex >= this.chapterDocList.length || chapterDocIndex < 0) {
      return;
    }
    // 递增 generation，终止进行中的解码
    this.pageGenerations.set(
      chapterDocIndex,
      (this.pageGenerations.get(chapterDocIndex) || 0) + 1
    );
    const subDoc = this.getSubDocument(chapterDocIndex);
    if (subDoc && subDoc.body.innerHTML) {
      subDoc.body.innerHTML = "";
    }
  }

  // scroll 模式下只预取下一页，避免同时解码过多大页面
  async renderComicPage(chapterDocIndex: number) {
    if (
      chapterDocIndex >= this.chapterDocList.length ||
      chapterDocIndex < 0
    ) {
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

  // 页面由解析结果实时渲染，无静态 HTML 可缓存
  async preCache() {
    return "";
  }

  async getMetadata() {
    return new Promise<any>(async (resolve, reject) => {
      try {
        if (!this.djvu) {
          await this.parse();
        }
        const metadata = this.djvu!.metadata;
        const cover = await this.getCoverBlob();
        if (!cover) {
          resolve({
            name: metadata.title,
            author: metadata.author,
            description: metadata.description,
            publisher: metadata.publisher,
            cover: "",
          });
          return;
        }
        var reader = new FileReader();
        reader.readAsDataURL(cover);
        reader.onloadend = () => {
          resolve({
            name: metadata.title,
            author: metadata.author,
            description: metadata.description,
            publisher: metadata.publisher,
            cover: reader.result,
          });
        };
      } catch (error) {
        console.error(error);
        reject(error);
      }
    });
  }

  async doSearch(keyword: string): Promise<any[]> {
    if (!this.djvu || !keyword) return [];
    try {
      const results = this.djvu.search(keyword);
      const count = this.chapterDocList.length || this.djvu.pageCount || 1;
      return results.map((result) => {
        const pageIndex = result.pageIndex;
        return {
          excerpt: result.excerpt,
          cfi: JSON.stringify({
            text: result.excerpt,
            chapterTitle:
              this.chapterDocList[pageIndex]?.label || "Page " + (pageIndex + 1),
            chapterDocIndex: pageIndex,
            chapterHref: this.chapterDocList[pageIndex]?.href || "",
            count: "search",
            percentage: pageIndex / count,
            keyword: keyword,
          }),
        };
      });
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  // 朗读/文本提取：取当前页的隐藏文本
  async getCurrentPageText(): Promise<string[]> {
    const chapterDocIndex = parseInt(this.tempLocation.chapterDocIndex || "0");
    if (isNaN(chapterDocIndex) || chapterDocIndex < 0) return [];
    if (!this.djvu || chapterDocIndex >= this.djvu.pageCount) return [];
    try {
      const text = this.djvu.getPageText(chapterDocIndex);
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

  async getImageList(chapterDocIndex?: number): Promise<string[]> {
    const index =
      chapterDocIndex === undefined || chapterDocIndex === null
        ? parseInt(this.tempLocation.chapterDocIndex || "0")
        : chapterDocIndex;
    if (isNaN(index) || index < 0 || index > this.chapterDocList.length - 1) {
      return [];
    }
    const indices =
      this.readerMode === "double" && index % 2 === 0 ? [index, index + 1] : [index];
    const urls: string[] = [];
    for (const pageIndex of indices) {
      if (pageIndex > this.chapterDocList.length - 1) continue;
      try {
        const subDoc = this.getSubDocument(pageIndex);
        const canvas = subDoc?.querySelector("canvas");
        if (canvas) {
          urls.push((canvas as HTMLCanvasElement).toDataURL("image/jpeg", 0.85));
          continue;
        }
        const image = await this.renderPageImage(pageIndex);
        if (image) {
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.putImageData(
              new ImageData(
                new Uint8ClampedArray(image.rgba),
                image.width,
                image.height
              ),
              0,
              0
            );
            urls.push(canvas.toDataURL("image/jpeg", 0.85));
          }
        }
      } catch (error) {
        console.error(error);
      }
    }
    return urls;
  }
}

// 分片解码之间让出主线程，避免大页面解码时界面卡顿
const yieldToMainThread = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export default DjvuRender;
