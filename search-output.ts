const URL_KEYS = new Set([
  "url",
  "uri",
  "link",
  "href",
  "sourceurl",
  "imageurl",
  "pageurl",
  "canonicalurl",
  "permalink",
  "citationurl",
]);

const SEARCH_ROOTS = new Set([
  "web",
  "news",
  "images",
  "developer",
  "results",
  "organicresult",
  "organicresults",
  "searchresult",
  "searchresults",
]);

const SEARCH_CONTAINERS = new Set([
  "web",
  "news",
  "images",
  "developer",
  "data",
  "result",
  "results",
  "item",
  "items",
  "source",
  "sources",
  "document",
  "documents",
  "link",
  "links",
  "page",
  "pages",
  "hit",
  "hits",
  "match",
  "matches",
  "organicresult",
  "organicresults",
  "searchresult",
  "searchresults",
  "citation",
  "citations",
  "reference",
  "references",
  "metadata",
]);

function normalizeKey(key: string): string {
  return key.replace(/[^a-z]/gi, "").toLowerCase();
}

function addUrl(value: unknown, urls: Set<string>): void {
  if (typeof value !== "string") return;
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) urls.add(url);
}

function collectUrls(value: unknown, field: string | undefined, urls: Set<string>): void {
  if (typeof value === "string") {
    if (field && URL_KEYS.has(normalizeKey(field))) addUrl(value, urls);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, field, urls);
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (URL_KEYS.has(normalized)) {
      addUrl(child, urls);
    } else if (SEARCH_CONTAINERS.has(normalized)) {
      collectUrls(child, key, urls);
    }
  }
}

function hasSearchContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSearchContainer);
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(([key, child]) => {
    const normalized = normalizeKey(key);
    return SEARCH_ROOTS.has(normalized) ||
      (SEARCH_CONTAINERS.has(normalized) && hasSearchContainer(child));
  });
}

function isSearchTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("search");
}

function extractPlainTextUrls(text: string, urls: Set<string>): void {
  const matches = text.match(/https?:\/\/[^\s<>"'`\])}]+/gi) ?? [];
  for (const match of matches) {
    urls.add(match.replace(/[.,;:!?]+$/, ""));
  }
}

export function compactSearchResult(
  toolName: string,
  content: readonly { type: string; text?: string }[],
): { type: "text"; text: string }[] | undefined {
  const text = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) return undefined;

  const urls = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (isSearchTool(toolName)) extractPlainTextUrls(text, urls);
  }

  const structured =
    hasSearchContainer(parsed) || (isSearchTool(toolName) && Array.isArray(parsed));
  if (parsed !== undefined) collectUrls(parsed, undefined, urls);
  if (!isSearchTool(toolName) && !structured) return undefined;
  if (urls.size === 0 && !structured) return undefined;

  return [{
    type: "text",
    text: urls.size > 0 ? [...urls].join("\n") : "No results",
  }];
}
