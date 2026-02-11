type OutlineNodeLike = {
  id: string;
  title: string;
  pageIndex: number | null;
  topRatio: number | null;
  items?: OutlineNodeLike[];
  isRoot?: boolean;
  isCustom?: boolean;
  parentId?: string | null;
  createdAt?: number;
  order?: number;
};

export type MindmapStateV2Node = {
  id: string;
  title: string;
  pageIndex: number | null;
  topRatio: number | null;
  isRoot?: boolean;
  isCustom?: boolean;
  createdAt?: number;
  order?: number;
  children: string[];
};

export type MindmapStateV2 = {
  version: 2;
  rootId: string;
  nodes: Record<string, MindmapStateV2Node>;
  updatedAt: number;
};

export const normalizeLegacyParentOverrides = (
  value: unknown
): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const normalized: Record<string, string> = {};
  Object.entries(value as Record<string, unknown>).forEach(([nodeId, parentId]) => {
    if (!nodeId || typeof parentId !== 'string' || !parentId || nodeId === parentId) return;
    normalized[nodeId] = parentId;
  });
  return normalized;
};

const toNumberOrNull = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

const toOptionalNumber = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
};

const toOptionalBoolean = (value: unknown) => {
  if (typeof value !== 'boolean') return undefined;
  return value;
};

export const buildMindmapStateV2FromOutline = (
  outlineRoot: OutlineNodeLike | null | undefined,
  updatedAt = Date.now()
): MindmapStateV2 | null => {
  if (!outlineRoot || !outlineRoot.id) return null;
  const nodes: Record<string, MindmapStateV2Node> = {};
  const walk = (node: OutlineNodeLike) => {
    if (!node.id) return;
    const children = Array.isArray(node.items)
      ? node.items.map((child) => child?.id).filter((id): id is string => Boolean(id))
      : [];
    nodes[node.id] = {
      id: node.id,
      title: String(node.title || ''),
      pageIndex: toNumberOrNull(node.pageIndex),
      topRatio: toNumberOrNull(node.topRatio),
      isRoot: node.isRoot ? true : undefined,
      isCustom: node.isCustom ? true : undefined,
      createdAt: toOptionalNumber(node.createdAt),
      order: toOptionalNumber(node.order),
      children
    };
    (node.items || []).forEach((child) => walk(child));
  };
  walk(outlineRoot);
  return {
    version: 2,
    rootId: outlineRoot.id,
    nodes,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
};

export const parseMindmapStateV2 = (value: unknown): MindmapStateV2 | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 2) return null;
  const rootId = typeof raw.rootId === 'string' ? raw.rootId : '';
  if (!rootId) return null;
  const rawNodes = raw.nodes;
  if (!rawNodes || typeof rawNodes !== 'object') return null;
  const entries = Object.entries(rawNodes as Record<string, unknown>);
  const nodes: Record<string, MindmapStateV2Node> = {};
  entries.forEach(([id, nodeValue]) => {
    if (!id || !nodeValue || typeof nodeValue !== 'object') return;
    const node = nodeValue as Record<string, unknown>;
    const nodeId = typeof node.id === 'string' ? node.id : id;
    if (!nodeId) return;
    const children = Array.isArray(node.children)
      ? node.children.filter((child): child is string => typeof child === 'string' && Boolean(child))
      : [];
    nodes[nodeId] = {
      id: nodeId,
      title: String(node.title || ''),
      pageIndex: toNumberOrNull(node.pageIndex),
      topRatio: toNumberOrNull(node.topRatio),
      isRoot: toOptionalBoolean(node.isRoot),
      isCustom: toOptionalBoolean(node.isCustom),
      createdAt: toOptionalNumber(node.createdAt),
      order: toOptionalNumber(node.order),
      children
    };
  });
  if (!nodes[rootId]) return null;
  return {
    version: 2,
    rootId,
    nodes,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now()
  };
};

export const deriveLegacyMindmapDataFromV2 = (
  state: MindmapStateV2,
  options?: { rootIdAlias?: string }
) => {
  const rootIdAlias = options?.rootIdAlias || state.rootId;
  const customChapters: OutlineNodeLike[] = [];
  const chapterParentOverrides: Record<string, string> = {};
  const visited = new Set<string>();
  const root = state.nodes[state.rootId];
  if (!root) {
    return { customChapters, chapterParentOverrides };
  }

  const remapRootId = (id: string | null | undefined) => {
    if (!id) return null;
    if (id === state.rootId) return rootIdAlias;
    return id;
  };

  const walk = (nodeId: string, parentId: string | null) => {
    if (!nodeId || visited.has(nodeId)) return;
    const node = state.nodes[nodeId];
    if (!node) return;
    visited.add(nodeId);

    if (nodeId !== state.rootId && node.isCustom) {
      customChapters.push({
        id: node.id,
        title: node.title,
        pageIndex: node.pageIndex,
        topRatio: node.topRatio,
        items: [],
        isCustom: true,
        parentId: remapRootId(parentId),
        createdAt: node.createdAt,
        order: node.order
      });
    }

    (node.children || []).forEach((childId) => {
      walk(childId, node.id);
    });
  };

  walk(state.rootId, null);
  return { customChapters, chapterParentOverrides };
};

export const mergeLegacyParentOverridesIntoCustomChapters = <T extends OutlineNodeLike>(
  customChapters: T[],
  overrides: Record<string, string>
) => {
  if (!Array.isArray(customChapters) || !customChapters.length) return [];
  if (!overrides || !Object.keys(overrides).length) {
    return customChapters.map((item) => ({ ...item }));
  }
  const nodes = customChapters.map((item) => ({
    ...item,
    parentId: item.parentId ?? null
  }));
  const nodeMap = new Map<string, T & { parentId: string | null }>();
  nodes.forEach((item) => {
    if (!item.id) return;
    nodeMap.set(item.id, item);
  });
  const createsCycle = (nodeId: string, nextParentId: string) => {
    let current: string | null = nextParentId;
    const visited = new Set<string>();
    while (current && nodeMap.has(current) && !visited.has(current)) {
      if (current === nodeId) return true;
      visited.add(current);
      current = nodeMap.get(current)?.parentId || null;
    }
    return false;
  };
  Object.entries(overrides).forEach(([nodeId, nextParentId]) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (!nextParentId || nextParentId === nodeId) return;
    if (createsCycle(nodeId, nextParentId)) return;
    node.parentId = nextParentId;
  });
  return nodes;
};
