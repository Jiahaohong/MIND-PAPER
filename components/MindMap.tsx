import React, { useMemo, useRef } from 'react';
import { Ban } from 'lucide-react';

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
const MINDMAP_NOTE_FONT_SIZE = MINDMAP_FONT_SIZE;
const MINDMAP_NOTE_TRANSLATION_FONT_SIZE = 10;
const MINDMAP_LINE_HEIGHT = 16;
const MINDMAP_NOTE_LINE_HEIGHT = MINDMAP_LINE_HEIGHT;
const MINDMAP_EDIT_TOOLBAR_MIN_WIDTH = 320;
const MINDMAP_EDIT_TOOLBAR_HEIGHT = 30;
const MINDMAP_EDIT_TOOLBAR_GAP = 8;

const toSolidColor = (fill: string) => {
  const match = fill.match(/rgba?\(([^)]+)\)/);
  if (!match) return fill;
  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return fill;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
};

const isManualMindmapNote = (note: any) => {
  if (!note) return false;
  if (note.source === 'manual') return true;
  if (note.source === 'pdf') return false;
  const rects = Array.isArray(note.rects) ? note.rects : [];
  if (!rects.length) return true;
  return rects.every((rect) => Number(rect?.w || 0) === 0 && Number(rect?.h || 0) === 0);
};

export type MindMapNode = {
  id: string;
  text: string;
  translation?: string;
  kind: 'root' | 'chapter' | 'note';
  isNormalChapter?: boolean;
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

type MindMapDropTarget = {
  id: string;
  position: 'before' | 'after' | 'inside';
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
  zoomScale?: number;
  collapsedIds?: Set<string>;
  expandedNoteIds?: Set<string>;
  offset?: { x: number; y: number };
  onNodeClick?: (node: MindMapNode) => void;
  onNodeMouseDown?: (node: MindMapNode, event: React.MouseEvent<SVGGElement>) => void;
  onNodeDoubleClick?: (node: MindMapNode, event: React.MouseEvent<SVGGElement>) => void;
  onBackgroundMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onLayout?: (layout: MindMapLayout | null) => void;
  onLayoutStart?: () => void;
  dropTarget?: MindMapDropTarget | null;
  draggingNoteId?: string | null;
  selectedNodeId?: string | null;
  onNoteToggleExpand?: (noteId: string) => void;
  onNodeToggleCollapse?: (node: MindMapNode) => void;
  toolbarColors?: Array<{ id: string; swatch: string; fill: string }>;
  onToolbarColorSelect?: (node: MindMapNode, color: string) => void;
  onToolbarMakeChapter?: (node: MindMapNode) => void;
  onToolbarClear?: (node: MindMapNode) => void;
  editingNodeId?: string | null;
  editingValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: (node: MindMapNode, value: string) => void;
  onEditCancel?: () => void;
}

export const MindMap: React.FC<MindMapProps> = ({
  root,
  zoomScale = 1,
  collapsedIds = new Set(),
  expandedNoteIds = new Set(),
  offset,
  onNodeClick,
  onNodeMouseDown,
  onNodeDoubleClick,
  onBackgroundMouseDown,
  onLayout,
  onLayoutStart,
  dropTarget,
  draggingNoteId,
  selectedNodeId,
  onNoteToggleExpand,
  onNodeToggleCollapse,
  toolbarColors = [],
  onToolbarColorSelect,
  onToolbarMakeChapter,
  onToolbarClear,
  editingNodeId,
  editingValue,
  onEditChange,
  onEditCommit,
  onEditCancel
}) => {
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [activeActionNodeId, setActiveActionNodeId] = React.useState<string | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);

  const nodeChildCountMap = React.useMemo(() => {
    const map = new Map<string, number>();
    const walk = (node: MindMapNode) => {
      const count = node.children?.length || 0;
      map.set(node.id, count);
      node.children?.forEach((child) => walk(child));
    };
    if (root) walk(root);
    return map;
  }, [root]);

  React.useEffect(() => {
    if (!editingNodeId) return;
    const handle = window.requestAnimationFrame(() => {
      if (editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.select();
      }
    });
    return () => window.cancelAnimationFrame(handle);
  }, [editingNodeId]);

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
      const isEditing = Boolean(editingNodeId && editingNodeId === node.id);
      const text = isEditing && typeof editingValue === 'string' ? editingValue : node.text || '';
      const translation = node.translation || '';
      const isNote = node.kind === 'note';
      const isRoot = node.kind === 'root';
      const noteId = (node.note as any)?.id || null;
      const isNoteExpanded =
        isNote && noteId ? expandedNoteIds.has(noteId) || isEditing : false;
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
      const effectiveMaxWidth = isEditing
        ? Math.max(maxWidth, MINDMAP_EDIT_TOOLBAR_MIN_WIDTH - paddingX * 2)
        : maxWidth;
      let lines = wrapTextLines(text, effectiveMaxWidth - paddingX * 2, ctx);
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
      if (isEditing) {
        translationLines = [];
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
      let width = Math.ceil(contentWidth + paddingX * 2);
      if (isEditing) {
        width = Math.max(width, MINDMAP_EDIT_TOOLBAR_MIN_WIDTH);
      }
      const translationHeight = translationLines.length
        ? translationLines.length * lineHeight + MINDMAP_NOTE_TRANSLATION_GAP
        : 0;
      let height = Math.ceil(lines.length * lineHeight + translationHeight + paddingY * 2);
      if (isEditing) {
        const contentHeight = Math.max(lines.length * lineHeight, 44) + paddingY * 2;
        height = Math.ceil(contentHeight + MINDMAP_EDIT_TOOLBAR_HEIGHT + MINDMAP_EDIT_TOOLBAR_GAP);
      }
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
  }, [root, collapsedIds, expandedNoteIds, editingNodeId, editingValue, toolbarColors]);

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
        <g transform={`translate(${dragOffset.x}, ${dragOffset.y})`}>
          <g transform={`scale(${zoomScale})`}>
            <g transform={`translate(${layout.offset.x}, ${layout.offset.y})`}>
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
              const isEditing = Boolean(editingNodeId && editingNodeId === node.id);
              const isSelected = Boolean(selectedNodeId && selectedNodeId === node.id);
              const isManualNote = node.kind === 'note' && isManualMindmapNote(node.note);
              const isNormalChapter = node.kind === 'chapter' && Boolean(node.isNormalChapter);
              const useItalicNodeText = isManualNote || isNormalChapter;
              const selectedStroke =
                node.kind === 'note' && node.color
                  ? toSolidColor(node.color)
                  : '#94a3b8';
              const resolvedFill = isEditing ? 'transparent' : isHovered ? '#e5e7eb' : fill;
              const effectiveStroke = isEditing
                ? 'transparent'
                : isSelected
                  ? selectedStroke
                  : stroke;
              const strokeWidth = isEditing ? 0 : isSelected ? 2 : 1;
              const showActions = activeActionNodeId === node.id && !isEditing;
              const isDropInside =
                Boolean(dropTarget && dropTarget.id === node.id && dropTarget.position === 'inside');
              const dropLineY =
                dropTarget && dropTarget.id === node.id
                  ? dropTarget.position === 'before'
                    ? 0
                    : dropTarget.position === 'after'
                      ? node.height
                      : null
                  : null;
              const hasChildren = (nodeChildCountMap.get(node.id) || 0) > 0;
              const isCollapsed = collapsedIds.has(node.id);
              const actionSize = 14;
              const actionGap = 6;
              const toggleX = node.width + actionGap;
              const toggleY = Math.max(4, (node.height - actionSize) / 2);
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  role="button"
                  tabIndex={0}
                  data-mindmap-node="true"
                  data-mindmap-id={node.id}
                  data-mindmap-kind={node.kind}
                  style={{ cursor: isEditing ? 'text' : 'pointer', userSelect: 'none' }}
                  onClick={() => {
                    if (isEditing) return;
                    onNodeClick?.(node);
                  }}
                  onDoubleClick={(event) => {
                    if (isEditing) return;
                    if (onNodeDoubleClick) {
                      onNodeDoubleClick(node, event);
                      if (event.defaultPrevented) return;
                    }
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
                    if (isEditing) return;
                    const target = event.target as HTMLElement | null;
                    if (target?.closest?.('[data-mindmap-action="true"]')) return;
                    event.preventDefault();
                    onNodeMouseDown?.(node, event);
                  }}
                  onMouseEnter={() => {
                    setHoveredId(node.id);
                    setActiveActionNodeId(node.id);
                  }}
                  onMouseLeave={() => setHoveredId((prev) => (prev === node.id ? null : prev))}
                >
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={8}
                    ry={8}
                    fill={resolvedFill}
                    stroke={effectiveStroke}
                    strokeWidth={strokeWidth}
                    opacity={isDraggingNote ? 0.5 : 1}
                  />
                  {isDropInside ? (
                    <rect
                      x={2}
                      y={2}
                      width={Math.max(0, node.width - 4)}
                      height={Math.max(0, node.height - 4)}
                      rx={7}
                      ry={7}
                      fill="none"
                      stroke="#2563eb"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      pointerEvents="none"
                    />
                  ) : null}
                  {node.kind === 'note' && !isEditing ? (
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
                  {dropLineY !== null ? (
                    <line
                      x1={-6}
                      y1={dropLineY}
                      x2={node.width + 6}
                      y2={dropLineY}
                      stroke="#2563eb"
                      strokeWidth={2}
                      strokeLinecap="round"
                      pointerEvents="none"
                    />
                  ) : null}
                  {isEditing ? (
                    <foreignObject
                      x={0}
                      y={0}
                      width={node.width}
                      height={node.height}
                      style={{ overflow: 'visible' }}
                    >
                      <div
                        xmlns="http://www.w3.org/1999/xhtml"
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'stretch',
                          gap: `${MINDMAP_EDIT_TOOLBAR_GAP}px`
                        }}
                      >
                        <div
                          className="rounded-lg border border-gray-200 bg-white shadow-lg p-2"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex items-center gap-1.5">
                              {toolbarColors.map((color) => {
                                const isActive = node.color === color.fill;
                                return (
                                  <button
                                    key={color.id}
                                    type="button"
                                    className="w-5 h-5 rounded-md border border-gray-300 flex items-center justify-center"
                                    onClick={() => onToolbarColorSelect?.(node, color.fill)}
                                    style={{
                                      boxShadow: isActive ? `0 0 0 2px ${color.swatch}` : 'none',
                                      borderColor: isActive ? 'transparent' : undefined
                                    }}
                                  >
                                    <span
                                      className="w-3 h-3 rounded-sm"
                                      style={{ background: color.swatch }}
                                    />
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              className="w-5 h-5 rounded-md border border-gray-300 text-[10px] font-semibold text-gray-700 hover:bg-gray-50"
                              onClick={() => onToolbarMakeChapter?.(node)}
                              style={{
                                boxShadow:
                                  node.kind === 'chapter' ? '0 0 0 2px #9ca3af' : 'none',
                                borderColor: node.kind === 'chapter' ? 'transparent' : undefined
                              }}
                            >
                              T
                            </button>
                            <button
                              type="button"
                              className="w-5 h-5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                              onClick={() => onToolbarClear?.(node)}
                            >
                              <Ban size={12} />
                            </button>
                          </div>
                          <textarea
                            ref={editInputRef}
                            value={editingValue ?? node.text}
                            onChange={(event) => onEditChange?.(event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                onEditCancel?.();
                              }
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                onEditCommit?.(node, event.currentTarget.value);
                              }
                            }}
                            onBlur={(event) => {
                              onEditCommit?.(node, event.currentTarget.value);
                            }}
                            className="mt-2 w-full min-h-[44px] text-[11px] text-gray-600 bg-gray-50 rounded-md p-2 resize-none outline-none"
                            style={{
                              fontSize: `${node.fontSize}px`,
                              lineHeight: `${node.lineHeight}px`,
                              fontFamily: 'inherit',
                              fontStyle: useItalicNodeText ? 'italic' : 'normal'
                            }}
                          />
                        </div>
                      </div>
                    </foreignObject>
                  ) : node.kind === 'chapter' ? (
                    <text
                      x={MINDMAP_PADDING_X}
                      y={MINDMAP_PADDING_Y+2}
                      dominantBaseline="hanging"
                      style={{
                        fontSize: node.fontSize,
                        fill: '#111827',
                        userSelect: 'none',
                        fontStyle: useItalicNodeText ? 'italic' : 'normal'
                      }}
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
                  ) : (
                    <>
                      <text
                        x={MINDMAP_PADDING_X}
                        y={MINDMAP_PADDING_Y}
                        dominantBaseline="hanging"
                        style={{
                          fontSize: node.fontSize,
                          fill: '#111827',
                          userSelect: 'none',
                          fontStyle: useItalicNodeText ? 'italic' : 'normal'
                        }}
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
                            userSelect: 'none',
                            fontStyle: useItalicNodeText ? 'italic' : 'normal'
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
                    </>
                  )}
                  {showActions && hasChildren ? (
                    <g
                      data-mindmap-action="true"
                      transform={`translate(${toggleX}, ${toggleY})`}
                      style={{ cursor: 'pointer' }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onNodeToggleCollapse?.(node);
                      }}
                    >
                      <rect
                        width={actionSize}
                        height={actionSize}
                        rx={3}
                        ry={3}
                        fill="#ffffff"
                        stroke="#d1d5db"
                      />
                      <text
                        x={actionSize / 2}
                        y={actionSize / 2 + 0.5}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        style={{ fontSize: 11, fill: '#374151', userSelect: 'none' }}
                        pointerEvents="none"
                      >
                        {isCollapsed ? '+' : '-'}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
};
