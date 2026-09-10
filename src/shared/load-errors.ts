export type PageLoadError = {
  kind: "network" | "http" | "crashed";
  url: string;
  message: string;
};

export function samePageUrl(first: string | undefined, second: string): boolean {
  try {
    const firstUrl = new URL(first ?? "");
    const secondUrl = new URL(second);
    firstUrl.hash = "";
    secondUrl.hash = "";
    return firstUrl.href === secondUrl.href;
  } catch {
    return false;
  }
}

export function networkLoadError(failure: {
  isMainFrame?: boolean;
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
}, currentUrl: string): PageLoadError | null {
  if (!failure.isMainFrame || failure.errorCode === -3 || !samePageUrl(failure.validatedURL, currentUrl)) return null;
  const descriptions: Record<number, string> = {
    [-7]: "连接超时，请检查网络后重试",
    [-100]: "连接已关闭，请重试",
    [-101]: "连接被重置，请检查网络或代理设置",
    [-102]: "网站拒绝连接，请检查网址或代理设置",
    [-105]: "无法解析网站域名，请检查网址或 DNS 设置",
    [-106]: "网络已断开，请联网后重试",
    [-109]: "无法访问网站，请检查网络或代理设置",
    [-111]: "代理隧道连接失败，请检查代理设置",
    [-118]: "连接超时，请检查网络后重试",
    [-130]: "无法连接代理服务器，请检查代理设置",
    [-137]: "网站域名解析失败，请检查 DNS 设置",
    [-138]: "网络访问被阻止，请检查防火墙或网络设置",
    [-324]: "网站未返回内容，请稍后重试",
  };
  const code = failure.errorCode ?? 0;
  const description = descriptions[code] ?? (code <= -200 && code > -300
    ? "网站安全证书验证失败，请检查系统时间或联系网站管理员"
    : "页面加载失败，请检查网址和网络后重试");
  const detail = failure.errorDescription || (code ? String(code) : "");
  return { kind: "network", url: currentUrl, message: detail ? `${description}（${detail}）` : description };
}

export function httpLoadError(url: string, statusCode: number | undefined, currentUrl: string): PageLoadError | null {
  if (!samePageUrl(url, currentUrl) || statusCode === undefined || statusCode < 400 || statusCode > 599) return null;
  const descriptions: Record<number, string> = {
    401: "网站要求登录后访问",
    403: "网站拒绝访问，可能需要登录或完成验证",
    404: "网页不存在，请检查网址",
    407: "代理服务器要求身份验证",
    408: "网站请求超时，请重试",
    410: "网页已被移除",
    412: "网站拒绝了请求，可能需要完成验证",
    429: "访问过于频繁，请稍后重试",
    451: "网站因访问限制无法提供此页面",
    500: "网站服务器出错，请稍后重试",
    502: "网站网关出错，请稍后重试",
    503: "网站服务暂时不可用，请稍后重试",
    504: "网站网关超时，请稍后重试",
  };
  return { kind: "http", url, message: `${descriptions[statusCode] ?? "网站返回错误，请稍后重试"}（HTTP ${statusCode}）` };
}
