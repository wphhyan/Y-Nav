import { Category, LinkItem } from '../types';

/**
 * 分类层级工具
 *
 * 约定：
 * - 只支持两级：顶级分类（无 parentId）与子分类（parentId 指向某个顶级分类）。
 * - 分类顺序沿用 categories 数组顺序；同级的先后 = 它们在数组中的先后。
 * - 若 parentId 指向一个不存在的分类（数据损坏 / 云端数据被裁剪），
 *   该分类会被当作顶级分类处理，避免出现"孤儿分类"从界面上消失。
 */

/** 判断某个分类是否为顶级分类（含 parentId 失效的情况） */
export const isTopLevelCategory = (categories: Category[], category: Category): boolean => {
  if (!category.parentId) return true;
  if (category.parentId === category.id) return true;
  // parentId 指向的分类不存在 → 降级为顶级，避免链接和分类一起"消失"
  return !categories.some(c => c.id === category.parentId);
};

/** 取全部顶级分类（保持数组顺序） */
export const getTopLevelCategories = (categories: Category[]): Category[] =>
  categories.filter(c => isTopLevelCategory(categories, c));

/** 取某个父分类下的直接子分类（保持数组顺序） */
export const getChildCategories = (categories: Category[], parentId: string): Category[] =>
  categories.filter(c => c.parentId === parentId && c.id !== parentId);

/** 取与某个分类同级的分类列表（用于同级内上下移动） */
export const getSiblingCategories = (categories: Category[], category: Category): Category[] =>
  isTopLevelCategory(categories, category)
    ? getTopLevelCategories(categories)
    : getChildCategories(categories, category.parentId as string);

/** 分类自身 + 其所有子分类的 id 集合（聚合视图 / 角标计数用） */
export const getCategoryScopeIds = (categories: Category[], categoryId: string): string[] => [
  categoryId,
  ...getChildCategories(categories, categoryId).map(c => c.id)
];

/**
 * 隐藏判断（穿透父子）
 * 父分类被隐藏时，子分类同样视为隐藏，否则访客端会通过子分类看到本该藏起来的内容。
 */
export const isCategoryHidden = (categories: Category[], category: Category): boolean => {
  if (category.hidden) return true;
  if (!category.parentId) return false;
  const parent = categories.find(c => c.id === category.parentId);
  return !!parent?.hidden;
};

/**
 * 展开成"带层级的扁平列表"，供侧边栏、下拉框、转移分组菜单等按层级渲染。
 * 返回顺序即展示顺序，depth 用于缩进。
 */
export interface FlatCategoryNode {
  cat: Category;
  depth: number;
  hasChildren: boolean;
}

export const flattenCategoryTree = (categories: Category[]): FlatCategoryNode[] => {
  const nodes: FlatCategoryNode[] = [];

  getTopLevelCategories(categories).forEach(parent => {
    const children = getChildCategories(categories, parent.id);
    nodes.push({ cat: parent, depth: 0, hasChildren: children.length > 0 });
    children.forEach(child => {
      nodes.push({ cat: child, depth: 1, hasChildren: false });
    });
  });

  // 兜底：理论上不会发生，但若存在无法归位的分类，追加在末尾而不是丢弃
  const placed = new Set(nodes.map(n => n.cat.id));
  categories.forEach(cat => {
    if (!placed.has(cat.id)) {
      nodes.push({ cat, depth: 0, hasChildren: false });
    }
  });

  return nodes;
};

/**
 * 校验一个分类能否挂到指定父分类下（用于分类管理弹窗）。
 * 只允许两级：父分类必须本身是顶级分类。
 */
export const canSetParent = (
  categories: Category[],
  childId: string,
  parentId?: string
): boolean => {
  if (!parentId) return true; // 提升为顶级，总是允许
  if (parentId === childId) return false; // 不能以自己为父
  // 自身已有子分类 → 不能再挂到别人下面，否则会形成三级
  if (getChildCategories(categories, childId).length > 0) return false;
  const parent = categories.find(c => c.id === parentId);
  if (!parent) return false;
  // 只支持两级：父分类自身必须是顶级，否则会形成三级
  return isTopLevelCategory(categories, parent);
};

/**
 * 收集"级联删除"需要一并删除的分类 id（自身 + 其子分类）。
 */
export const getCategoryCascadeIds = (categories: Category[], categoryIds: string[]): string[] => {
  const result = new Set<string>();
  categoryIds.forEach(id => {
    result.add(id);
    getChildCategories(categories, id).forEach(child => result.add(child.id));
  });
  return Array.from(result);
};

/**
 * 修复脏数据：清掉失效、自指、或会导致三级的 parentId。
 * 用于数据加载时兜底，保证界面永远只呈现两级结构。
 */export const normalizeCategoryParents = (categories: Category[]): Category[] => {
  const ids = new Set(categories.map(c => c.id));

  // 第一遍：去掉失效 / 自指的 parentId
  const cleaned = categories.map(cat => {
    if (cat.parentId && (cat.parentId === cat.id || !ids.has(cat.parentId))) {
      return { ...cat, parentId: undefined };
    }
    return cat;
  });

  // 第二遍：父级本身也是子分类（会形成三级）→ 降级为顶级
  const topLevelIds = new Set(cleaned.filter(c => !c.parentId).map(c => c.id));
  return cleaned.map(cat => {
    if (cat.parentId && !topLevelIds.has(cat.parentId)) {
      return { ...cat, parentId: undefined };
    }
    return cat;
  });
};

/** 主界面里"按子分类分块"的一块 */
export interface LinkGroup {
  id: string;
  name: string;
  icon: string;
  links: LinkItem[];
}

/**
 * 父分类视图：把链接按子分类分组，供主界面分块渲染。
 *
 * 规则（按产品决策）：
 * - 选中的分类没有子分类 → 返回 null，调用方维持原来的单张网格。
 * - 父分类自己直接挂的链接单独成组，标题用父分类名。
 * - 没有链接的子分类不出组（避免一排空网格）。
 * - 若最终只剩"父分类自身"这一组，返回 null 退回平铺，
 *   避免区块标题与页面标题重复。
 */
export const groupLinksBySubcategory = (
  categories: Category[],
  selectedCategoryId: string,
  links: LinkItem[]
): LinkGroup[] | null => {
  const children = getChildCategories(categories, selectedCategoryId);
  if (children.length === 0) return null;

  const selected = categories.find(c => c.id === selectedCategoryId);
  const groups: LinkGroup[] = [];

  const ownLinks = links.filter(link => link.categoryId === selectedCategoryId);
  if (ownLinks.length > 0) {
    groups.push({
      id: selectedCategoryId,
      name: selected?.name || '未命名分类',
      icon: selected?.icon || 'Folder',
      links: ownLinks
    });
  }

  children.forEach(child => {
    const childLinks = links.filter(link => link.categoryId === child.id);
    if (childLinks.length === 0) return;
    groups.push({ id: child.id, name: child.name, icon: child.icon, links: childLinks });
  });

  if (groups.length === 1 && groups[0].id === selectedCategoryId) return null;

  return groups;
};
