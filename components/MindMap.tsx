import React, { useMemo, useRef } from 'react';

const MINDMAP_GAP_X = 90;
const MINDMAP_GAP_Y = 18;
const MINDMAP_MARGIN = 60;
const MINDMAP_MAX_WIDTH = 240;
const MINDMAP_NOTE_MAX_WIDTH = 200;
const MINDMAP_NOTE_MAX_LINES = 2;
const MINDMAP_NOTE_TRANSLATION_MAX_LINES = 2;
const MINDMAP_NOTE_TRANSLATION_GAP = 4;
const MINDMAP_PADDING_X = 12;
const MINDMAP_PADDING_Y = 8;
const MINDMAP_NOTE_PADDING_X = 10;
const MINDMAP_NOTE_PADDING_Y = 6;
const MINDMAP_FONT_SIZE = 13;
const MINDMAP_ROOT_FONT_SIZE = 14;
const MINDMAP_NOTE_FONT_SIZE = 11;
const MINDMAP_NOTE_TRANSLATION_FONT_SIZE = 10;
const MINDMAP_LINE_HEIGHT = 16;
const MINDMAP_NOTE_LINE_HEIGHT = 14;

export type MindMapNode = {
  id: string;
  text: string;
  translation?: string;
  kind: 'root' | 'chapter' | 'note';
  pageIndex?: number | null;
  topRatio?: number | null;
  color?: string;
  note?: unknown;
  children?: MindMapNode[];
};

export type MindMapLayout = {
  nodes: LayoutNode[];
  edges: { from: LayoutNode; to: LayoutNode }[];
  offset: { x: number; y: number };
  width: number;
  height: number;
};

type LayoutNode = MindMapNode & {
  width: number;
  height: number;
  x: number;
  y: number;
  subtreeHeight: number;
  lines: string[];
  translationLines?: string[];
  translationGap?: number;
  lineHeight: number;
  fontSize: number;
  translationFontSize?: number;
};

const wrapTextLines = (text: string, maxWidth: number, ctx: CanvasRenderingContext2D | null) => {
  const safeText = String(text || '').trim();
  if (!safeText) return [''];
  const measure = (value: string) => {
    if (!ctx) return value.length * 8;
    return ctx.measureText(value).width;
  };
  const lines: string[] = [];
  let line = '';
  for (const char of safeText) {
    if (!line && char === ' ') continue;
    const nextLine = line + char;
    if (measure(nextLine) > maxWidth && line) {
      lines.push(line);
      line = char.trim() ? char : '';
    } else {
      line = nextLine;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const clampTextLines = (lines: string[], maxLines: number) => {
  if (!maxLines || lines.length <= maxLines) return lines;
  const next = lines.slice(0, maxLines);
  const lastIndex = maxLines - 1;
  const last = next[lastIndex] || '';
  const trimmed =
    last.length > 3 ? `${last.slice(0, Math.max(0, last.length - 3))}...` : `${last}...`;
  next[lastIndex] = trimmed;
  return next;
};

const cloneTree = (node: MindMapNode, collapsedIds: Set<string>): MindMapNode => ({
  ...node,
  children: collapsedIds.has(node.id)
    ? []
    : node.children?.map((child) => cloneTree(child, collapsedIds)) || []
});

interface MindMapProps {
  root: MindMapNode | null;
  collapsedIds?: Set<string>;
  expandedNoteIds?: Set<string>;
  offset?: { x: number; y: number };
  onNodeClick?: (node: MindMapNode) => void;
  onNodeMouseDown?: (node: MindMapNode, event: React.MouseEvent<SVGGElement>) => void;
  onBackgroundMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onLayout?: (layout: MindMapLayout | null) => void;
  onLayoutStart?: () => void;
  dragOverId?: string | null;
  draggingNoteId?: string | null;
  onNoteToggleExpand?: (noteId: string) => void;
}

export const MindMap: React.FC<MindMapProps> = ({
  root,
  collapsedIds = new Set(),
  expandedNoteIds = new Set(),
  offset,
  onNodeClick,
  onNodeMouseDown,
  onBackgroundMouseDown,
  onLayout,
  onLayoutStart,
  dragOverId,
  draggingNoteId,
  onNoteToggleExpand
}) => {
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const layout = useMemo(() => {
    try {
      if (onLayoutStart) onLayoutStart();
      if (!root) return null;
      if (typeof document === 'undefined' || !document.body) return null;
      if (!measureRef.current) {
        const canvas = document.createElement('canvas');
        measureRef.current = canvas.getContext('2d');
      }
      const ctx = measureRef.current;
      const rootNode = cloneTree(root, collapsedIds) as LayoutNode;

    const getMetrics = (node: MindMapNode) => {
      const text = node.text || '';
      const translation = node.translation || '';
      const isNote = node.kind === 'note';
      const isRoot = node.kind === 'root';
      const noteId = (node.note as any)?.id || null;
      const isNoteExpanded = isNote && noteId ? expandedNoteIds.has(noteId) : false;
      const fontSize = isNote ? MINDMAP_NOTE_FONT_SIZE : isRoot ? MINDMAP_ROOT_FONT_SIZE : MINDMAP_FONT_SIZE;
      const translationFontSize = isNote ? MINDMAP_NOTE_TRANSLATION_FONT_SIZE : fontSize;
      const lineHeight = isNote ? MINDMAP_NOTE_LINE_HEIGHT : MINDMAP_LINE_HEIGHT;
      const maxWidth = isNote ? MINDMAP_NOTE_MAX_WIDTH : MINDMAP_MAX_WIDTH;
      const paddingX = isNote ? MINDMAP_NOTE_PADDING_X : MINDMAP_PADDING_X;
      const paddingY = isNote ? MINDMAP_NOTE_PADDING_Y : MINDMAP_PADDING_Y;
      const fontWeight = isRoot ? '600' : '500';
      const fontFamily = document.body ? getComputedStyle(document.body).fontFamily : 'sans-serif';
      if (ctx) {
        ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      }
      let lines = wrapTextLines(text, maxWidth - paddingX * 2, ctx);
      let translationLines: string[] = [];
      if (translation) {
        if (ctx) {
          ctx.font = `${fontWeight} ${translationFontSize}px ${fontFamily}`;
        }
        translationLines = wrapTextLines(translation, maxWidth - paddingX * 2, ctx);
      }
      if (isNote && !isNoteExpanded) {
        lines = clampTextLines(lines, MINDMAP_NOTE_MAX_LINES);
        translationLines = clampTextLines(translationLines, MINDMAP_NOTE_TRANSLATION_MAX_LINES);
      }
      const lineWidths: number[] = [];
      if (lines.length) {
        if (ctx) {
          ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        }
        lines.forEach((line) => {
          lineWidths.push(ctx ? ctx.measureText(line).width : line.length * fontSize * 0.6);
        });
      }
      if (translationLines.length) {
        if (ctx) {
          ctx.font = `${fontWeight} ${translationFontSize}px ${fontFamily}`;
        }
        translationLines.forEach((line) => {
          lineWidths.push(
            ctx ? ctx.measureText(line).width : line.length * translationFontSize * 0.6
          );
        });
      }
      const contentWidth = Math.min(maxWidth, Math.max(...lineWidths, fontSize * 0.8));
      const width = Math.ceil(contentWidth + paddingX * 2);
      const translationHeight = translationLines.length
        ? translationLines.length * lineHeight + MINDMAP_NOTE_TRANSLATION_GAP
        : 0;
      const height = Math.ceil(lines.length * lineHeight + translationHeight + paddingY * 2);
      return {
        width,
        height,
        lines,
        translationLines,
        translationGap: translationLines.length ? MINDMAP_NOTE_TRANSLATION_GAP : 0,
        lineHeight,
        fontSize,
        translationFontSize
      };
    };

    const applyMetrics = (node: LayoutNode) => {
      const metrics = getMetrics(node);
      node.width = metrics.width;
      node.height = metrics.height;
      node.lines = metrics.lines;
      node.translationLines = metrics.translationLines;
      node.translationGap = metrics.translationGap;
      node.lineHeight = metrics.lineHeight;
      node.fontSize = metrics.fontSize;
      node.translationFontSize = metrics.translationFontSize;
      if (!node.children?.length) return;
      node.children.forEach((child) => applyMetrics(child as LayoutNode));
    };

    const calcHeight = (node: LayoutNode) => {
      if (!node.children?.length) {
        node.subtreeHeight = node.height;
        return node.subtreeHeight;
      }
      let total = 0;
      node.children.forEach((child, index) => {
        total += calcHeight(child as LayoutNode);
        if (index < node.children.length - 1) total += MINDMAP_GAP_Y;
      });
      node.subtreeHeight = Math.max(node.height, total);
      return node.subtreeHeight;
    };

    const positionTree = (node: LayoutNode, x: number, yTop: number) => {
      const subtreeHeight = node.subtreeHeight || node.height;
      node.x = x;
      node.y = yTop + (subtreeHeight - node.height) / 2;
      if (!node.children?.length) return;
      let cursor = yTop;
      node.children.forEach((child) => {
        positionTree(child as LayoutNode, x + node.width + MINDMAP_GAP_X, cursor);
        cursor += (child.subtreeHeight || child.height) + MINDMAP_GAP_Y;
      });
    };

    applyMetrics(rootNode);
    calcHeight(rootNode);
    positionTree(rootNode, 0, 0);

    const nodes: LayoutNode[] = [];
    const edges: { from: LayoutNode; to: LayoutNode }[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const walk = (node: LayoutNode) => {
      nodes.push(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
      node.children?.forEach((child) => {
        edges.push({ from: node, to: child as LayoutNode });
        walk(child as LayoutNode);
      });
    };

    walk(rootNode);

    const offset = {
      x: MINDMAP_MARGIN - minX,
      y: MINDMAP_MARGIN - minY
    };

      return {
        nodes,
        edges,
        offset,
        width: maxX - minX + MINDMAP_MARGIN * 2,
        height: maxY - minY + MINDMAP_MARGIN * 2
      };
    } catch (error) {
      console.error('[MindMap] layout error', error);
      return null;
    }
  }, [root, collapsedIds, expandedNoteIds]);

  React.useEffect(() => {
    if (onLayout) onLayout(layout);
  }, [layout, onLayout]);

  if (!layout) {
    return <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">正在生成思维导图...</div>;
  }

  const dragOffset = offset || { x: 0, y: 0 };

  return (
    <div
      className="w-full h-full overflow-hidden bg-white"
      onMouseDown={(event) => {
        if (!onBackgroundMouseDown) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('[data-mindmap-node=\"true\"]')) return;
        onBackgroundMouseDown(event);
      }}
    >
      <svg width="100%" height="100%">
        <g transform={`translate(${layout.offset.x + dragOffset.x}, ${layout.offset.y + dragOffset.y})`}>
          <g fill="none" stroke="#cbd5f5" strokeWidth={1.5}>
            {layout.edges.map((edge) => {
              const startX = edge.from.x + edge.from.width;
              const startY = edge.from.y + edge.from.height / 2;
              const endX = edge.to.x;
              const endY = edge.to.y + edge.to.height / 2;
              const curve = Math.min(80, Math.max(40, (endX - startX) * 0.5));
              const c1x = startX + curve;
              const c1y = startY;
              const c2x = endX - curve;
              const c2y = endY;
              const path = `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`;
              return <path key={`${edge.from.id}-${edge.to.id}`} d={path} />;
            })}
          </g>
          <g>
            {layout.nodes.map((node) => {
              const fill =
                node.kind === 'note'
                  ? '#ffffff'
                  : node.kind === 'root'
                    ? '#eef2ff'
                    : '#ffffff';
              const stroke = '#e5e7eb';
              const isDraggingNote =
                node.kind === 'note' &&
                node.note &&
                draggingNoteId &&
                (node.note as any).id === draggingNoteId;
              const isHovered = hoveredId === node.id;
              const resolvedFill = isHovered ? '#e5e7eb' : fill;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  role="button"
                  tabIndex={0}
                  data-mindmap-node="true"
                  data-mindmap-id={node.id}
                  data-mindmap-kind={node.kind}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => onNodeClick?.(node)}
                  onDoubleClick={(event) => {
                    if (node.kind !== 'note') return;
                    const noteId = (node.note as any)?.id;
                    if (!noteId || !onNoteToggleExpand) return;
                    event.stopPropagation();
                    onNoteToggleExpand(noteId);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onNodeClick?.(node);
                    }
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onNodeMouseDown?.(node, event);
                  }}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((prev) => (prev === node.id ? null : prev))}
                >
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={8}
                    ry={8}
                    fill={resolvedFill}
                    stroke={stroke}
                    strokeWidth={1}
                    opacity={isDraggingNote ? 0.5 : 1}
                  />
                  {node.kind === 'note' ? (
                    <rect
                      x={0}
                      y={0}
                      width={4}
                      height={node.height}
                      rx={8}
                      ry={8}
                      fill={node.color || '#cbd5f5'}
                    />
                  ) : null}
                  <text
                    x={MINDMAP_PADDING_X}
                    y={MINDMAP_PADDING_Y}
                    dominantBaseline="hanging"
                    style={{ fontSize: node.fontSize, fill: '#111827', userSelect: 'none' }}
                    pointerEvents="none"
                  >
                    {node.lines.map((line, index) => (
                      <tspan
                        key={`${node.id}-line-${index}`}
                        x={MINDMAP_PADDING_X}
                        dy={index === 0 ? 0 : node.lineHeight}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {node.translationLines?.length ? (
                    <text
                      x={MINDMAP_PADDING_X}
                      y={
                        MINDMAP_PADDING_Y +
                        node.lines.length * node.lineHeight +
                        (node.translationGap || 0)
                      }
                      dominantBaseline="hanging"
                      style={{
                        fontSize: node.translationFontSize || node.fontSize,
                        fill: '#6b7280',
                        userSelect: 'none'
                      }}
                      pointerEvents="none"
                    >
                      {node.translationLines.map((line, index) => (
                        <tspan
                          key={`${node.id}-translation-${index}`}
                          x={MINDMAP_PADDING_X}
                          dy={index === 0 ? 0 : node.lineHeight}
                        >
                          {line}
                        </tspan>
                      ))}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
};
