import { Category, LinkItem } from "../types";
import { getChildCategories, getTopLevelCategories } from "../utils/categoryTree";

/**
 * Generates a Netscape Bookmark HTML string compatible with Chrome/Edge/Firefox import.
 * 二级分类会输出为嵌套文件夹，导入后层级得以保留。
 */
export const generateBookmarkHtml = (links: LinkItem[], categories: Category[]): string => {
  const now = Math.floor(Date.now() / 1000);

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // Helper to escape HTML special characters
  const escapeHtml = (unsafe: string) => {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  // Group links by category
  const linksByCat = new Map<string, LinkItem[]>();
  links.forEach(link => {
    const list = linksByCat.get(link.categoryId) || [];
    list.push(link);
    linksByCat.set(link.categoryId, list);
  });

  const emitted = new Set<string>();

  // 递归输出一个分类（含其子分类），indent 控制缩进层级
  const renderCategory = (cat: Category, indent: number): string => {
    const pad = '    '.repeat(indent);
    let out = `${pad}<DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${escapeHtml(cat.name)}</H3>\n`;
    out += `${pad}<DL><p>\n`;

    emitted.add(cat.id);
    (linksByCat.get(cat.id) || []).forEach(link => {
      const date = Math.floor(link.createdAt / 1000);
      const iconAttr = link.icon ? ` ICON="${link.icon}"` : '';
      out += `${pad}    <DT><A HREF="${link.url}" ADD_DATE="${date}"${iconAttr}>${escapeHtml(link.title)}</A>\n`;
    });

    getChildCategories(categories, cat.id).forEach(child => {
      out += renderCategory(child, indent + 1);
    });

    out += `${pad}</DL><p>\n`;
    return out;
  };

  // 1. Process Categories（顶级分类，子分类嵌套在其内部）
  getTopLevelCategories(categories).forEach(cat => {
    html += renderCategory(cat, 1);
  });

  // 2. 兜底：父分类已失效的"孤儿"分类，提升为顶级输出，避免丢失
  categories.forEach(cat => {
    if (!emitted.has(cat.id)) {
      html += renderCategory(cat, 1);
    }
  });

  // 3. Process Uncategorized (links with invalid categoryId)
  const validCatIds = new Set(categories.map(c => c.id));
  const uncategorized = links.filter(l => !validCatIds.has(l.categoryId));

  if (uncategorized.length > 0) {
    html += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">未分类</H3>\n`;
    html += `    <DL><p>\n`;
    uncategorized.forEach(link => {
        const date = Math.floor(link.createdAt / 1000);
        html += `        <DT><A HREF="${link.url}" ADD_DATE="${date}">${escapeHtml(link.title)}</A>\n`;
    });
    html += `    </DL><p>\n`;
  }

  html += `</DL><p>`;

  return html;
};

export const downloadHtmlFile = (content: string, filename: string = 'bookmarks.html') => {
  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};