// 双页紧排时两页在中线贴合，标记挂在书内容的 iframe body 上
const TIGHT_DOUBLE_PAGE_ATTR = "data-kookit-tight-double-page";

export const setTightDoublePage = (
  doc: Document | null | undefined,
  tight: boolean
) => {
  try {
    if (!doc?.body) return;
    if (tight) {
      doc.body.setAttribute(TIGHT_DOUBLE_PAGE_ATTR, "yes");
    } else {
      doc.body.removeAttribute(TIGHT_DOUBLE_PAGE_ATTR);
    }
  } catch (error) {}
};

export const isTightDoublePage = (
  doc: Document | null | undefined
): boolean => {
  try {
    return doc?.body?.getAttribute(TIGHT_DOUBLE_PAGE_ATTR) === "yes";
  } catch (error) {
    return false;
  }
};

// 紧排时无间隙，其他模式沿用原公式
export const getPageGap = (
  size: number,
  doc?: Document | null
): number => {
  if (isTightDoublePage(doc)) return 0;
  const section = Math.floor(size / 12);
  return section % 2 === 0 ? section : section - 1;
};

// 紧排时单图页向中线靠拢
export const alignPageContentToCenter = (
  iframe: HTMLIFrameElement | null | undefined
) => {
  if (!iframe) return;
  const apply = () => {
    try {
      const ownerDoc = iframe.ownerDocument;
      const container = iframe.parentElement;
      const subDoc = iframe.contentDocument;
      const body = subDoc?.body;
      if (!ownerDoc || !container || !body) return;
      const shifted = body.querySelector<HTMLElement>(
        "[data-kookit-center-shift]"
      );
      if (!isTightDoublePage(ownerDoc)) {
        if (shifted) {
          shifted.style.transform = "";
          shifted.removeAttribute("data-kookit-center-shift");
        }
        return;
      }
      const images = body.querySelectorAll("img, svg");
      if (images.length !== 1 || body.textContent?.trim()) return;
      const image = images[0] as HTMLElement;
      const available =
        subDoc.documentElement.clientWidth || body.clientWidth;
      const width = image.getBoundingClientRect().width;
      const shift = (available - width) / 2;
      if (!(shift > 0.5)) return;
      const stride = ownerDoc.body.clientWidth;
      if (!stride) return;
      const rect = container.getBoundingClientRect();
      // 横版跨页独占一屏时不偏移
      if (rect.width >= stride - 1) {
        if (shifted) {
          shifted.style.transform = "";
          shifted.removeAttribute("data-kookit-center-shift");
        }
        return;
      }
      const positionInView =
        ((rect.left % stride) + stride) % stride;
      const isLeftPage = positionInView < stride / 2;
      image.setAttribute("data-kookit-center-shift", "yes");
      image.style.transform = `translateX(${
        isLeftPage ? shift : -shift
      }px)`;
    } catch (error) {}
  };
  apply();
  requestAnimationFrame(apply);
  try {
    const image = iframe.contentDocument?.body?.querySelector("img");
    if (image && !image.complete) {
      image.addEventListener("load", apply, { once: true });
    }
  } catch (error) {}
};
