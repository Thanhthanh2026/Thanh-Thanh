/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from '@google/genai';

// --- Types ---
interface Property {
  id: string;
  name: string;
}

interface DiagramObject {
  id: string;
  name: string;
  properties: Property[];
  backgroundColor?: string;
}

type LinkStyle = 'solid' | 'dashed';
type ArrowStyle = 'forward' | 'backward' | 'both' | 'none';

interface Relationship {
  id:string;
  source: string;
  target: string;
  label: string;
  linkStyle?: LinkStyle;
  arrowStyle?: ArrowStyle;
  controlPoint?: { x: number; y: number };
  properties?: Property[];
}

interface DiagramImage {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Cluster {
  id: string;
  name: string;
  nodeIds: string[];
  backgroundColor?: string;
}

interface Annotation {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  backgroundColor?: string;
}

interface DiagramData {
  title: string;
  description: string;
  context: string;
  lesson: string;
  objects: DiagramObject[];
  relationships: Relationship[];
  images?: DiagramImage[];
  clusters?: Cluster[];
  annotations?: Annotation[];
}

interface EnrichedDiagramData {
    data: DiagramData;
    keywordNumbers: Map<string, number>;
}

interface LayoutData {
    nodes: { id: string; x: number; y: number }[];
    propertyPositions: Record<string, { x: number; y: number }>;
    relationshipPropertyPositions: Record<string, { x: number; y: number }>;
}

// FIX: Renamed custom interface `Node` to `DiagramNode` to resolve a name collision with the built-in DOM `Node` type, which was causing type errors on line 167.
interface DiagramNode extends DiagramObject {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// --- Helper Functions ---

// Function to calculate a darker shade for the border
const shadeColor = (color: string, percent: number) => {
    let R = parseInt(color.substring(1,3),16);
    let G = parseInt(color.substring(3,5),16);
    let B = parseInt(color.substring(5,7),16);

    R = parseInt(String(R * (100 + percent) / 100));
    G = parseInt(String(G * (100 + percent) / 100));
    B = parseInt(String(B * (100 + percent) / 100));

    R = (R<255)?R:255;  
    G = (G<255)?G:255;  
    B = (B<255)?B:255;  

    const RR = ((R.toString(16).length==1)?"0"+R.toString(16):R.toString(16));
    const GG = ((G.toString(16).length==1)?"0"+G.toString(16):G.toString(16));
    const BB = ((B.toString(16).length==1)?"0"+B.toString(16):B.toString(16));

    return "#"+RR+GG+BB;
}

// Function to get contrasting text color (black or white)
const getContrastingTextColor = (bgColor: string) => {
    if (!bgColor) return '#fce883'; // Default color
    const color = (bgColor.charAt(0) === '#') ? bgColor.substring(1, 7) : bgColor;
    const r = parseInt(color.substring(0, 2), 16); // hexToR
    const g = parseInt(color.substring(2, 4), 16); // hexToG
    const b = parseInt(color.substring(4, 6), 16); // hexToB
    return (((r * 0.299) + (g * 0.587) + (b * 0.114)) > 186) ?
        '#000000' :
        '#FFFFFF';
}

// Finds the intersection of a line between two points (p1, p2) and a rectangle centered at p1.
const getRectangleIntersection = (p1: {x: number, y: number}, p2: {x: number, y: number}, dims: {width: number, height: number}) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    const { width, height } = dims;
    const halfW = width / 2;
    const halfH = height / 2;

    if (dx === 0 && dy === 0) return p1;

    // Calculate the slope of the line
    const slopeY = Math.abs(dy / dx);
    // Calculate the slope of the diagonal of the rectangle
    const slopeRect = height / width;

    let ix, iy;

    if (slopeY < slopeRect) {
        // Intersects with the left or right side
        if (dx > 0) { // right side
            ix = p1.x + halfW;
            iy = p1.y + halfW * (dy / dx);
        } else { // left side
            ix = p1.x - halfW;
            iy = p1.y - halfW * (dy / dx);
        }
    } else {
        // Intersects with the top or bottom side
        if (dy > 0) { // bottom side
            iy = p1.y + halfH;
            ix = p1.x + halfH * (dx / dy);
        } else { // top side
            iy = p1.y - halfH;
            ix = p1.x - halfH * (dx / dy);
        }
    }

    return { x: ix, y: iy };
};

// --- Custom Hook for Undo/Redo State Management ---
const useHistoryState = <T,>(initialState: T) => {
    const [history, setHistory] = useState<T[]>([initialState]);
    const [currentIndex, setCurrentIndex] = useState(0);

    const currentState = history[currentIndex];

    const setState = (newState: T) => {
        const newHistory = history.slice(0, currentIndex + 1);
        newHistory.push(newState);
        setHistory(newHistory);
        setCurrentIndex(newHistory.length - 1);
    };

    const undo = () => {
        if (currentIndex > 0) {
            setCurrentIndex(currentIndex - 1);
        }
    };

    const redo = () => {
        if (currentIndex < history.length - 1) {
            setCurrentIndex(currentIndex - 1);
        }
    };
    
    const resetState = (newState: T) => {
        setHistory([newState]);
        setCurrentIndex(0);
    }

    const canUndo = currentIndex > 0;
    const canRedo = currentIndex < history.length - 1;

    return { currentState, setState, undo, redo, canUndo, canRedo, resetState };
};


// --- Inline Editor Component ---
const InlineEditor: React.FC<{
    initialValue: string;
    onSave: (newValue: string) => void;
    onCancel: () => void;
    x: number; y: number; width: number; height: number;
    multiline?: boolean;
}> = ({ initialValue, onSave, onCancel, x, y, width, height, multiline }) => {
    const [value, setValue] = useState(initialValue);
    // Use a generic ref type that can hold either element
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const handleSave = (e: React.MouseEvent) => {
        e.stopPropagation();
        onSave(value);
    };

    const handleCancel = (e: React.MouseEvent) => {
        e.stopPropagation();
        onCancel();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // For multiline, don't submit on Enter. User must click the save button.
        if (e.key === 'Enter' && !multiline) {
            e.preventDefault();
            onSave(value);
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    }
    
    const editorContent = multiline ? (
        <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
        />
    ) : (
        <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
        />
    );


    // FIX: Suppress TypeScript error for the 'xmlns' attribute, which is not in React's HTML types but is needed for foreignObject content.
    // @ts-ignore
    const editorDiv = <div className="inline-editor" xmlns="http://www.w3.org/1999/xhtml">
        {editorContent}
        <button onClick={handleSave}>✓</button>
        <button onClick={handleCancel}>✗</button>
    </div>;

    return (
        <foreignObject x={x} y={y} width={width} height={height}>
            {editorDiv}
        </foreignObject>
    );
};

// --- Link Style Editor ---
const LinkStyleEditor: React.FC<{
    relationship: Relationship;
    position: { x: number; y: number };
    onStyleChange: (relId: string, updates: Partial<Relationship>) => void;
    onClose: () => void;
}> = ({ relationship, position, onStyleChange, onClose }) => {
    const editorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (editorRef.current && !editorRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [onClose]);

    // @ts-ignore
    const editorDiv = <div ref={editorRef} className="link-style-editor" xmlns="http://www.w3.org/1999/xhtml">
        <div className="style-group">
            <button title="Forward" className={relationship.arrowStyle === 'forward' ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { arrowStyle: 'forward' })}>→</button>
            <button title="Backward" className={relationship.arrowStyle === 'backward' ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { arrowStyle: 'backward' })}>←</button>
            <button title="Both" className={relationship.arrowStyle === 'both' ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { arrowStyle: 'both' })}>↔</button>
            <button title="None" className={(!relationship.arrowStyle || relationship.arrowStyle === 'none') ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { arrowStyle: 'none' })}>─</button>
            <div className="separator"></div>
            <button title="Solid" className={(!relationship.linkStyle || relationship.linkStyle === 'solid') ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { linkStyle: 'solid' })}>─</button>
            <button title="Dashed" className={relationship.linkStyle === 'dashed' ? 'active' : ''} onClick={() => onStyleChange(relationship.id, { linkStyle: 'dashed' })}>╍</button>
        </div>
    </div>;

    return (
        <foreignObject x={position.x} y={position.y} width={250} height={50}>
            {editorDiv}
        </foreignObject>
    );
};

// --- Color Picker Component ---
const PREDEFINED_COLORS = [
    '#1e1e1e', // Default
    '#5c2b29', // Red
    '#614a19', // Orange
    '#635d19', // Yellow
    '#345920', // Green
    '#16504b', // Teal
    '#2d555e', // Blue
    '#284255', // Indigo
    '#42275e', // Purple
    '#5b2245', // Pink
];

const ColorPicker: React.FC<{
    position: { x: number; y: number };
    onColorChange: (color: string) => void;
    onClose: () => void;
}> = ({ position, onColorChange, onClose }) => {
    const pickerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [onClose]);
    
    // @ts-ignore
    const pickerDiv = <div ref={pickerRef} className="color-picker" xmlns="http://www.w3.org/1999/xhtml">
        {PREDEFINED_COLORS.map(color => (
            <button
                key={color}
                className="color-swatch"
                style={{ backgroundColor: color }}
                onClick={() => {
                    onColorChange(color === '#1e1e1e' ? '' : color);
                    onClose();
                }}
                aria-label={`Set color to ${color}`}
            />
        ))}
    </div>;

    return (
        <foreignObject x={position.x} y={position.y} width={130} height={60}>
            {pickerDiv}
        </foreignObject>
    );
};


// --- Mermaid Modal Component ---
const MermaidModal: React.FC<{ code: string; onClose: () => void }> = ({ code, onClose }) => {
  const [copyButtonText, setCopyButtonText] = useState('Copy to Clipboard');

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopyButtonText('Copied!');
    setTimeout(() => setCopyButtonText('Copy to Clipboard'), 2000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>Mermaid Code</h3>
        <p>Copy the code below and paste it into a Mermaid.js compatible editor.</p>
        <pre>
          <code>{code}</code>
        </pre>
        <div className="modal-actions">
          <button onClick={handleCopy} className="control-button">{copyButtonText}</button>
          <button onClick={onClose} className="control-button">Close</button>
        </div>
      </div>
    </div>
  );
};

// --- Diagram Component ---
interface DiagramProps {
    data: DiagramData;
    keywordNumbers: Map<string, number>;
    onDataChange: (newData: DiagramData) => void;
    showProperties: boolean;
    showRelationships: boolean;
    highlightedIds?: Set<string> | null;
    initialLayout?: LayoutData | null;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
}

interface DiagramRef {
  getSvgElement: () => SVGSVGElement | null;
  getLayout: () => LayoutData;
}

type Selection = { type: 'node' | 'property' | 'relationship' | 'link-line' | 'image' | 'relationship-property' | 'cluster' | 'annotation'; key: string };
type EditingItem = Selection & { initialValue: string };

const Diagram = forwardRef<DiagramRef, DiagramProps>(({ data, keywordNumbers, onDataChange, showProperties, showRelationships, highlightedIds, initialLayout, searchQuery, onSearchQueryChange }, ref) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const titleTextRef = useRef<SVGTextElement>(null);

  const [nodes, setNodes] = useState<DiagramNode[]>([]);
  const [isDraggingNode, setIsDraggingNode] = useState<string | null>(null);
  
  const [selectedItem, setSelectedItem] = useState<Selection | null>(null);
  const [multiSelectedNodeIds, setMultiSelectedNodeIds] = useState<Set<string>>(new Set());
  const [editingItem, setEditingItem] = useState<EditingItem | null>(null);
  const [editingLinkStyle, setEditingLinkStyle] = useState<Relationship | null>(null);
  const [editingColorNodeId, setEditingColorNodeId] = useState<string | null>(null);
  const [editingColorClusterId, setEditingColorClusterId] = useState<string | null>(null);
  const [editingColorAnnotationId, setEditingColorAnnotationId] = useState<string | null>(null);

  const [propertyPositions, setPropertyPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingPropertyKey, setDraggingPropertyKey] = useState<string | null>(null);
  const [relationshipPropertyPositions, setRelationshipPropertyPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingRelationshipPropertyKey, setDraggingRelationshipPropertyKey] = useState<string | null>(null);
  
  const [titleBox, setTitleBox] = useState({ x: 0, y: 0, width: 0, height: 0 });

  // Pan and Zoom state
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });

  // State for creating new links
  const [linkingNodeId, setLinkingNodeId] = useState<string | null>(null);

  // State for image interactions
  const [draggingImageId, setDraggingImageId] = useState<string | null>(null);
  const [resizingImage, setResizingImage] = useState<{ id: string; initialMouseX: number; initialWidth: number; initialHeight: number; } | null>(null);
  const [draggingRelationshipId, setDraggingRelationshipId] = useState<string | null>(null);
  const [draggingCluster, setDraggingCluster] = useState<{ id: string; initialNodePositions: Map<string, { x: number; y: number }>; initialMousePos: { x: number; y: number }; } | null>(null);
  const [draggingAnnotationId, setDraggingAnnotationId] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    getSvgElement: () => svgRef.current,
    getLayout: () => ({
        nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y })),
        propertyPositions,
        relationshipPropertyPositions
    })
  }));

  // Pre-calculate node dimensions based on text length
  const nodeDimensions = useMemo(() => {
    const dimensions = new Map<string, { width: number; height: number }>();
    data.objects.forEach(obj => {
        const textWidth = obj.name.length * 7 + 30; // 7px per char + 30px padding
        dimensions.set(obj.id, { width: Math.max(80, textWidth), height: 40 });
    });
    return dimensions;
  }, [data.objects]);

  // Update title box dimensions
  useEffect(() => {
    if (titleTextRef.current) {
        const bbox = titleTextRef.current.getBBox();
        setTitleBox({
            x: bbox.x - 15,
            y: bbox.y - 10,
            width: bbox.width + 30,
            height: bbox.height + 20,
        });
    }
  }, [data.title, data.description, viewBox]); // Re-run when title or viewBox changes

  // Initialize viewBox and observe resize
  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) return;

    const setInitialViewBox = () => {
        setViewBox({
            x: 0,
            y: 0,
            width: svgElement.clientWidth,
            height: svgElement.clientHeight
        });
    };
    
    setInitialViewBox();

    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const { width, height } = entry.contentRect;
            setViewBox(vb => ({ ...vb, width, height }));
        }
    });

    resizeObserver.observe(svgElement);
    return () => resizeObserver.disconnect();
  }, [svgRef]);

  // Physics simulation for initial layout. Only runs when the component key changes.
  useEffect(() => {
    const svgElement = svgRef.current;
    if (!data || !svgElement) return;
    
    const width = svgElement.clientWidth;
    const height = svgElement.clientHeight;

    if (width === 0 || height === 0) return;

    if (initialLayout) {
        const layoutNodesMap = new Map(initialLayout.nodes.map(n => [n.id, n]));
        const loadedNodes = data.objects.map(obj => {
            const layoutNode = layoutNodesMap.get(obj.id);
            return {
                ...obj,
                x: layoutNode?.x ?? width / 2 + (Math.random() - 0.5) * 50,
                y: layoutNode?.y ?? height / 2 + (Math.random() - 0.5) * 50,
                vx: 0, vy: 0,
            };
        });
        setNodes(loadedNodes);
        setPropertyPositions(initialLayout.propertyPositions || {});
        setRelationshipPropertyPositions(initialLayout.relationshipPropertyPositions || {});
        return; // Skip simulation
    }

    const initialNodes = data.objects.map(obj => ({
      ...obj,
      x: width / 2 + (Math.random() - 0.5) * 100,
      y: height / 2 + (Math.random() - 0.5) * 100,
      vx: 0,
      vy: 0,
    }));
    
    const simulationSteps = 300;
    let currentNodes: DiagramNode[] = initialNodes;
    for (let step = 0; step < simulationSteps; step++) {
        // Stage 1: Calculate new positions based on forces.
        const nextNodes = currentNodes.map((node: DiagramNode): DiagramNode => {
            let { x, y, vx, vy } = node;

            // Repulsion force from other nodes
            currentNodes.forEach((otherNode: DiagramNode) => {
                if (node.id === otherNode.id) return;
                const dx = x - otherNode.x;
                const dy = y - otherNode.y;
                let distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 1) distance = 1;
                const force = 120000 / (distance * distance); // Stronger repulsion
                vx += (dx / distance) * force;
                vy += (dy / distance) * force;
            });

            // Spring force from relationships
            data.relationships.forEach(rel => {
                const idealDistance = 300; // Tighter ideal distance
                if (rel.source === node.id) {
                    const targetNode = currentNodes.find((n: DiagramNode) => n.id === rel.target);
                    if (!targetNode) return;
                    const dx = targetNode.x - x;
                    const dy = targetNode.y - y;
                    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = 0.03 * (distance - idealDistance);
                    vx += (dx / distance) * force;
                    vy += (dy / distance) * force;
                }
                if (rel.target === node.id) {
                    const sourceNode = currentNodes.find((n: DiagramNode) => n.id === rel.source);
                    if (!sourceNode) return;
                    const dx = sourceNode.x - x;
                    const dy = sourceNode.y - y;
                    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = 0.03 * (distance - idealDistance);
                    vx += (dx / distance) * force;
                    vy += (dy / distance) * force;
                }
            });
            
            // Centering force
            vx += (width / 2 - x) * 0.005;
            vy += (height / 2 - y) * 0.005;

            // Apply damping and update position
            vx *= 0.6;
            vy *= 0.6;
            x += vx;
            y += vy;
            
            return { ...node, x, y, vx, vy };
        });

        // Stage 2: Resolve collisions by adjusting positions directly.
        const collisionPasses = 5;
        for (let k = 0; k < collisionPasses; k++) {
            for (let i = 0; i < nextNodes.length; i++) {
                for (let j = i + 1; j < nextNodes.length; j++) {
                    const nodeA = nextNodes[i];
                    const nodeB = nextNodes[j];

                    const dimsA = nodeDimensions.get(nodeA.id) || { width: 80, height: 40 };
                    const dimsB = nodeDimensions.get(nodeB.id) || { width: 80, height: 40 };

                    const dx = nodeB.x - nodeA.x;
                    const dy = nodeB.y - nodeA.y;

                    const minDx = (dimsA.width / 2) + (dimsB.width / 2) + 30; // Horizontal padding
                    const minDy = (dimsA.height / 2) + (dimsB.height / 2) + 20; // Vertical padding

                    const absDx = Math.abs(dx);
                    const absDy = Math.abs(dy);

                    if (absDx < minDx && absDy < minDy) {
                        const overlapX = minDx - absDx;
                        const overlapY = minDy - absDy;
                        
                        // Resolve collision along the axis with the smallest overlap
                        if (overlapX < overlapY) {
                            const sign = dx > 0 ? 1 : -1;
                            const moveX = (overlapX / 2) * sign;
                            nodeA.x -= moveX;
                            nodeB.x += moveX;
                        } else {
                            const sign = dy > 0 ? 1 : -1;
                            const moveY = (overlapY / 2) * sign;
                            nodeA.y -= moveY;
                            nodeB.y += moveY;
                        }
                    }
                }
            }
        }

        // Stage 3: Constrain nodes to SVG boundaries after all adjustments.
        nextNodes.forEach(node => {
            const nodeDims = nodeDimensions.get(node.id) || { width: 80, height: 40 };
            node.x = Math.max(nodeDims.width / 2, Math.min(width - nodeDims.width / 2, node.x));
            node.y = Math.max(nodeDims.height / 2, Math.min(height - nodeDims.height / 2, node.y));
        });

        // Set the result for the next iteration.
        currentNodes = nextNodes;
    }
    setNodes(currentNodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array ensures this runs only once on mount. The key prop on Diagram handles re-initialization.
  
  // Sync nodes state with data prop without re-running simulation
  useEffect(() => {
    setNodes(prevNodes => {
      const currentObjectIds = new Set(data.objects.map(o => o.id));
      // Filter out deleted nodes, keep positions of existing ones
      const newNodes = prevNodes
        .filter(node => currentObjectIds.has(node.id))
        .map(node => { // Update node data like name/properties without changing position
            const updatedData = data.objects.find(obj => obj.id === node.id);
            return {
                ...node, // Keep x, y, vx, vy
                ...updatedData, // Update name, properties, etc.
            };
        });

      // Add new nodes if any
      const existingNodeIds = new Set(newNodes.map(n => n.id));
      data.objects.forEach(obj => {
        if (!existingNodeIds.has(obj.id)) {
            const sourceNode = prevNodes.find(n => n.id === obj.id.split('_copy_')[0]);
            newNodes.push({
                ...obj,
                x: (sourceNode?.x ?? viewBox.x + viewBox.width / 2) + 50,
                y: (sourceNode?.y ?? viewBox.y + viewBox.height / 2) + 50,
                vx: 0,
                vy: 0,
            });
        }
      });
      return newNodes;
    });
  }, [data.objects, viewBox.x, viewBox.y, viewBox.width, viewBox.height]);
  
  const nodesMap = useMemo(() => nodes.reduce((acc, node) => {
    acc[node.id] = node;
    return acc;
  }, {} as Record<string, DiagramNode>), [nodes]);

  const linkGroups = useMemo(() => {
    const groups = new Map<string, Relationship[]>();
    data.relationships.forEach(rel => {
        const key = [rel.source, rel.target].sort().join('--');
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(rel);
    });
    return groups;
  }, [data.relationships]);

  const relationshipLayouts = useMemo(() => {
    const layouts = new Map<string, { pathData: string; labelPosition: { x: number; y: number } }>();
    if (!nodes.length) return layouts;

    linkGroups.forEach((group) => {
      group.forEach((rel, i) => {
        const source = nodesMap[rel.source];
        const target = nodesMap[rel.target];
        if (!source || !target) return;

        const sourceDims = nodeDimensions.get(source.id)!;
        const targetDims = nodeDimensions.get(target.id)!;
        const groupCount = group.length;

        let pathData, labelPosition;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const midX = source.x + dx / 2;
        const midY = source.y + dy / 2;

        if (rel.controlPoint) {
            const controlX = midX + rel.controlPoint.x;
            const controlY = midY + rel.controlPoint.y;
            const startPoint = getRectangleIntersection(source, {x: controlX, y: controlY}, sourceDims);
            const endPoint = getRectangleIntersection(target, {x: controlX, y: controlY}, targetDims);

            pathData = `M ${startPoint.x} ${startPoint.y} Q ${controlX} ${controlY} ${endPoint.x} ${endPoint.y}`;
            labelPosition = {
                x: 0.25 * startPoint.x + 0.5 * controlX + 0.25 * endPoint.x,
                y: 0.25 * startPoint.y + 0.5 * controlY + 0.25 * endPoint.y,
            };
        } else if (groupCount > 1) {
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / dist; // Normal vector (perpendicular)
            const ny = dx / dist;

            const totalSpacing = 20;
            const curveFactor = 25;
            const offsetIndex = (i - (groupCount - 1) / 2);

            const parallelOffset = offsetIndex * totalSpacing;
            const controlPointOffset = parallelOffset + (Math.sign(offsetIndex) || 1) * curveFactor;
            
            const virtualSourceForTarget = { x: source.x + nx * parallelOffset, y: source.y + ny * parallelOffset };
            const virtualTargetForSource = { x: target.x + nx * parallelOffset, y: target.y + ny * parallelOffset };

            const startPoint = getRectangleIntersection(source, virtualTargetForSource, sourceDims);
            const endPoint = getRectangleIntersection(target, virtualSourceForTarget, targetDims);
            
            const midX = (startPoint.x + endPoint.x) / 2;
            const midY = (startPoint.y + endPoint.y) / 2;
            
            const controlX = midX + nx * controlPointOffset;
            const controlY = midY + ny * controlPointOffset;

            pathData = `M ${startPoint.x} ${startPoint.y} Q ${controlX} ${controlY} ${endPoint.x} ${endPoint.y}`;
            labelPosition = {
                x: 0.25 * startPoint.x + 0.5 * controlX + 0.25 * endPoint.x,
                y: 0.25 * startPoint.y + 0.5 * controlY + 0.25 * endPoint.y,
            };
        } else {
            const startPoint = getRectangleIntersection(source, target, sourceDims);
            const endPoint = getRectangleIntersection(target, source, targetDims);
            pathData = `M ${startPoint.x} ${startPoint.y} L ${endPoint.x} ${endPoint.y}`;
            labelPosition = {x: midX, y: midY};
        }

        layouts.set(rel.id, { pathData, labelPosition });
      });
    });

    return layouts;
  }, [nodes, linkGroups, nodesMap, nodeDimensions]);

  const multiSelectBBox = useMemo(() => {
    if (multiSelectedNodeIds.size < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    multiSelectedNodeIds.forEach(nodeId => {
        const node = nodesMap[nodeId];
        if (!node) return;
        const dims = nodeDimensions.get(nodeId) || { width: 0, height: 0 };
        minX = Math.min(minX, node.x - dims.width / 2);
        minY = Math.min(minY, node.y - dims.height / 2);
        maxX = Math.max(maxX, node.x + dims.width / 2);
        maxY = Math.max(maxY, node.y + dims.height / 2);
    });
    if (minX === Infinity) return null;
    return { x: (minX + maxX) / 2, y: minY - 40 };
  }, [multiSelectedNodeIds, nodesMap, nodeDimensions]);

  const clusterBBoxes = useMemo(() => {
      const bboxes = new Map<string, { x: number; y: number; width: number; height: number }>();
      if (!data.clusters || !nodes.length) return bboxes;

      data.clusters.forEach(cluster => {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          let foundNodes = 0;
          cluster.nodeIds.forEach(nodeId => {
              const node = nodesMap[nodeId];
              if (node) {
                  foundNodes++;
                  const dims = nodeDimensions.get(nodeId)!;
                  minX = Math.min(minX, node.x - dims.width / 2);
                  minY = Math.min(minY, node.y - dims.height / 2);
                  maxX = Math.max(maxX, node.x + dims.width / 2);
                  maxY = Math.max(maxY, node.y + dims.height / 2);
              }
          });

          if (foundNodes > 0) {
              const padding = 25;
              bboxes.set(cluster.id, {
                  x: minX - padding,
                  y: minY - padding - 20, // Extra space for title
                  width: (maxX - minX) + padding * 2,
                  height: (maxY - minY) + padding * 2 + 20,
              });
          }
      });
      return bboxes;
  }, [data.clusters, nodesMap, nodeDimensions, nodes]); // nodes dependency is important here

  // Initialize or update property positions
  useEffect(() => {
    if (!nodes.length) return;
    setPropertyPositions(prevPositions => {
        const newPositions: Record<string, { x: number; y: number }> = {};
        const allCurrentKeys = new Set<string>();

        nodes.forEach(node => {
            node.properties.forEach((prop, i) => {
                const key = prop.id; // Use stable ID
                allCurrentKeys.add(key);
                if (prevPositions[key]) {
                    newPositions[key] = prevPositions[key];
                } else {
                    const nodeDims = nodeDimensions.get(node.id)!;
                    const angle = (i / (node.properties.length || 1)) * (2 * Math.PI) - (Math.PI / 2);
                    const farPoint = { x: Math.cos(angle) * 1000, y: Math.sin(angle) * 1000 };
                    const startPoint = getRectangleIntersection({x: 0, y: 0}, farPoint, nodeDims);
                    const lineLength = 20 + (prop.name.length * 2.5);
                    const endX = Math.cos(angle) * lineLength + startPoint.x;
                    const endY = Math.sin(angle) * lineLength + startPoint.y;
                    newPositions[key] = { x: endX, y: endY };
                }
            });
        });
        
        const finalPositions = { ...prevPositions };
        Object.keys(prevPositions).forEach(key => {
            if (!allCurrentKeys.has(key)) {
                delete finalPositions[key];
            }
        });
        Object.keys(newPositions).forEach(key => {
            if (!finalPositions[key]) {
                finalPositions[key] = newPositions[key];
            }
        });

        return finalPositions;
    });
}, [nodes, data.objects, nodeDimensions]);

// Initialize or update relationship property positions
useEffect(() => {
    if (!data.relationships.length) return;
    setRelationshipPropertyPositions(prevPositions => {
        const newPositions: Record<string, { x: number; y: number }> = {};
        const allCurrentKeys = new Set<string>();

        data.relationships.forEach(rel => {
            if (!Array.isArray(rel.properties)) return;
            
            rel.properties.forEach((prop, i) => {
                const key = prop.id;
                allCurrentKeys.add(key);
                if (prevPositions[key]) {
                    newPositions[key] = prevPositions[key];
                } else {
                    const angle = (i / (rel.properties.length || 1)) * (2 * Math.PI) - (Math.PI / 2);
                    const lineLength = 20 + (prop.name.length * 2.5);
                    const endX = Math.cos(angle) * lineLength;
                    const endY = Math.sin(angle) * lineLength;
                    newPositions[key] = { x: endX, y: endY };
                }
            });
        });
        
        const finalPositions = { ...prevPositions };
        Object.keys(prevPositions).forEach(key => {
            if (!allCurrentKeys.has(key)) {
                delete finalPositions[key];
            }
        });
        Object.keys(newPositions).forEach(key => {
            if (!finalPositions[key]) {
                finalPositions[key] = newPositions[key];
            }
        });

        return finalPositions;
    });
}, [data.relationships]);

 // Cancel linking when Ctrl/Cmd is released
 useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
        if (!e.ctrlKey && !e.metaKey) {
            setLinkingNodeId(null);
        }
    };
    window.addEventListener('keyup', handleKeyUp);
    return () => {
        window.removeEventListener('keyup', handleKeyUp);
    };
 }, []);

 const clearPopups = () => {
    setEditingLinkStyle(null);
    setEditingColorNodeId(null);
    setEditingColorClusterId(null);
    setEditingColorAnnotationId(null);
    setSelectedItem(null);
    setMultiSelectedNodeIds(new Set());
 };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    
    if (e.shiftKey) {
        setMultiSelectedNodeIds(prev => {
            const newSelection = new Set(prev);
            if (newSelection.has(nodeId)) {
                newSelection.delete(nodeId);
            } else {
                newSelection.add(nodeId);
            }
            return newSelection;
        });
        setSelectedItem(null);
        return;
    }

    clearPopups();
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    if (isCtrlOrCmd) {
        if (!linkingNodeId) { // First node selection for linking
            setLinkingNodeId(nodeId);
            setIsDraggingNode(null); // Ensure no drag starts
        } else { // Second node selection
            if (linkingNodeId !== nodeId) {
                // Create new relationship
                const newRelationship: Relationship = {
                    id: crypto.randomUUID(),
                    source: linkingNodeId,
                    target: nodeId,
                    label: 'Hành vi',
                    linkStyle: 'solid',
                    arrowStyle: 'none',
                };
                onDataChange({
                    ...data,
                    relationships: [...data.relationships, newRelationship],
                });
            }
            // Reset after second click (whether successful link or same node click)
            setLinkingNodeId(null);
        }
        return; // Prevent any other actions
    }

    // Default behavior (no Ctrl/Cmd key)
    setIsDraggingNode(nodeId);
    setSelectedItem({ type: 'node', key: nodeId });
    if (linkingNodeId) setLinkingNodeId(null); // Cancel linking if we start a normal drag
  };

  const handlePropertyMouseDown = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    clearPopups();
    setLinkingNodeId(null);
    setDraggingPropertyKey(key);
    setSelectedItem({ type: 'property', key });
  };
  
  const handleRelationshipMouseDown = (e: React.MouseEvent, relId: string) => {
    e.stopPropagation();
    clearPopups();
    setDraggingRelationshipId(relId);
    setSelectedItem({ type: 'relationship', key: relId });
    setLinkingNodeId(null);
  };
  
  const handleRelationshipPropertyMouseDown = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    clearPopups();
    setLinkingNodeId(null);
    setDraggingRelationshipPropertyKey(key);
    setSelectedItem({ type: 'relationship-property', key });
  };

  const handleClusterMouseDown = (e: React.MouseEvent, clusterId: string) => {
    e.stopPropagation();
    clearPopups();
    setSelectedItem({ type: 'cluster', key: clusterId });

    const cluster = data.clusters?.find(c => c.id === clusterId);
    if (!cluster) return;

    const svg = svgRef.current;
    if (!svg) return;
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = e.clientX;
    svgPoint.y = e.clientY;
    const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());

    const initialNodePositions = new Map<string, {x: number, y: number}>();
    cluster.nodeIds.forEach(nodeId => {
        const node = nodesMap[nodeId];
        if (node) {
            initialNodePositions.set(nodeId, { x: node.x, y: node.y });
        }
    });

    setDraggingCluster({
        id: clusterId,
        initialNodePositions,
        initialMousePos: transformedPoint,
    });
  };

  const handleAnnotationMouseDown = (e: React.MouseEvent, annotationId: string) => {
    e.stopPropagation();
    clearPopups();
    setDraggingAnnotationId(annotationId);
    setSelectedItem({ type: 'annotation', key: annotationId });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    
    if (isPanning.current) {
        const dx = e.clientX - panStart.current.x;
        const dy = e.clientY - panStart.current.y;
        const scale = viewBox.width / svg.clientWidth;
        setViewBox(v => ({ ...v, x: v.x - dx * scale, y: v.y - dy * scale }));
        panStart.current = { x: e.clientX, y: e.clientY };
        return;
    }
    
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = e.clientX;
    svgPoint.y = e.clientY;
    const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());

    if (draggingCluster) {
        const dx = transformedPoint.x - draggingCluster.initialMousePos.x;
        const dy = transformedPoint.y - draggingCluster.initialMousePos.y;

        setNodes(prevNodes => prevNodes.map(n => {
            const initialPos = draggingCluster.initialNodePositions.get(n.id);
            if (initialPos) {
                return { ...n, x: initialPos.x + dx, y: initialPos.y + dy, vx: 0, vy: 0 };
            }
            return n;
        }));
        return;
    }

    if (isDraggingNode) {
        setNodes(prevNodes => prevNodes.map(n => n.id === isDraggingNode ? { ...n, x: transformedPoint.x, y: transformedPoint.y, vx: 0, vy: 0 } : n));
        return;
    }

    if (draggingPropertyKey) {
        const [nodeId] = draggingPropertyKey.split('::');
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        const newX = transformedPoint.x - node.x;
        const newY = transformedPoint.y - node.y;
        
        setPropertyPositions(prev => ({ ...prev, [draggingPropertyKey]: { x: newX, y: newY } }));
        return;
    }

    if (draggingRelationshipPropertyKey) {
        const [relId] = draggingRelationshipPropertyKey.split('::');
        const layout = relationshipLayouts.get(relId);
        if (!layout) return;

        const { labelPosition } = layout;
        const newX = transformedPoint.x - labelPosition.x;
        const newY = transformedPoint.y - labelPosition.y;
        
        setRelationshipPropertyPositions(prev => ({ ...prev, [draggingRelationshipPropertyKey]: { x: newX, y: newY } }));
        return;
    }
    
    if (draggingRelationshipId) {
        const rel = data.relationships.find(r => r.id === draggingRelationshipId);
        const source = nodesMap[rel.source];
        const target = nodesMap[rel.target];
        if (!rel || !source || !target) return;

        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        
        const newControlPoint = {
            x: transformedPoint.x - midX,
            y: transformedPoint.y - midY,
        };

        const updatedRelationships = data.relationships.map(r =>
            r.id === draggingRelationshipId ? { ...r, controlPoint: newControlPoint } : r
        );
        onDataChange({ ...data, relationships: updatedRelationships });
        return;
    }

    if (draggingImageId) {
        const updatedImages = data.images?.map(img =>
            img.id === draggingImageId ? { ...img, x: transformedPoint.x - img.width/2, y: transformedPoint.y - img.height/2 } : img
        );
        onDataChange({ ...data, images: updatedImages });
        return;
    }

    if (resizingImage) {
        if (!resizingImage.initialHeight) return;
        const dx = transformedPoint.x - resizingImage.initialMouseX;
        const newWidth = resizingImage.initialWidth + dx;
        const aspectRatio = resizingImage.initialWidth / resizingImage.initialHeight;
        const newHeight = newWidth / aspectRatio;
        
        const updatedImages = data.images?.map(img =>
            img.id === resizingImage.id ? { ...img, width: Math.max(20, newWidth), height: Math.max(20, newHeight) } : img
        );
        onDataChange({ ...data, images: updatedImages });
        return;
    }

    if (draggingAnnotationId) {
        const updatedAnnotations = data.annotations?.map(ann => 
            ann.id === draggingAnnotationId ? { ...ann, x: transformedPoint.x - ann.width / 2, y: transformedPoint.y - 15 } : ann
        );
        onDataChange({ ...data, annotations: updatedAnnotations });
        return;
    }
  };
  
  const handleMouseUp = () => {
    setIsDraggingNode(null);
    setDraggingPropertyKey(null);
    setDraggingImageId(null);
    setResizingImage(null);
    setDraggingRelationshipId(null);
    setDraggingRelationshipPropertyKey(null);
    setDraggingCluster(null);
    setDraggingAnnotationId(null);
    if (isPanning.current) {
        isPanning.current = false;
        if (svgRef.current) svgRef.current.style.cursor = 'grab';
    }
  };
  
  const handleSVGMouseDown = (e: React.MouseEvent) => {
    if (e.target !== svgRef.current) return;
    setLinkingNodeId(null); // Cancel linking on background click
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    if (svgRef.current) svgRef.current.style.cursor = 'grabbing';
    clearPopups();
  };

  const handleSVGDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== svgRef.current) return; // Only trigger on background
    
    const svg = svgRef.current;
    if (!svg) return;
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = e.clientX;
    svgPoint.y = e.clientY;
    const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());
    const noteWidth = 150;

    const newAnnotation: Annotation = {
        id: crypto.randomUUID(),
        text: 'Ghi chú',
        x: transformedPoint.x - noteWidth / 2,
        y: transformedPoint.y - 15,
        width: noteWidth,
    };

    const newData = {
        ...data,
        annotations: [...(data.annotations || []), newAnnotation],
    };
    onDataChange(newData);
    
    // Immediately go into edit mode
    setTimeout(() => {
        setSelectedItem({ type: 'annotation', key: newAnnotation.id });
        setEditingItem({ type: 'annotation', key: newAnnotation.id, initialValue: newAnnotation.text });
    }, 0);
  };
  
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;

    const zoomFactor = 1.1;
    const { clientX, clientY } = e;
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = clientX;
    svgPoint.y = clientY;

    const pointInSVG = svgPoint.matrixTransform(svg.getScreenCTM()!.inverse());
    
    const scale = e.deltaY < 0 ? 1 / zoomFactor : zoomFactor;
    const newWidth = viewBox.width * scale;
    const newHeight = viewBox.height * scale;
    const newX = pointInSVG.x - (pointInSVG.x - viewBox.x) * scale;
    const newY = pointInSVG.y - (pointInSVG.y - viewBox.y) * scale;

    setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
  };
  
  const handleSVGTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 2) return;

    const svg = svgRef.current;
    if (!svg) return;

    // Helper to find which node (if any) is under a touch point
    const getTouchedNodeId = (touch: React.Touch): string | null => {
        const svgPoint = svg.createSVGPoint();
        svgPoint.x = touch.clientX;
        svgPoint.y = touch.clientY;
        const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());
        
        // Find a node that contains the transformed point
        const touchedNode = nodes.find(node => {
            const nodeDims = nodeDimensions.get(node.id)!;
            const halfW = nodeDims.width / 2;
            const halfH = nodeDims.height / 2;
            return (
                transformedPoint.x >= node.x - halfW &&
                transformedPoint.x <= node.x + halfW &&
                transformedPoint.y >= node.y - halfH &&
                transformedPoint.y <= node.y + halfH
            );
        });
        return touchedNode ? touchedNode.id : null;
    };

    const nodeId1 = getTouchedNodeId(e.touches[0]);
    const nodeId2 = getTouchedNodeId(e.touches[1]);

    // If both touches are on two different nodes, create a link
    if (nodeId1 && nodeId2 && nodeId1 !== nodeId2) {
        e.preventDefault(); // Prevent default touch behavior like zoom/pan
        const newRelationship: Relationship = {
            id: crypto.randomUUID(),
            source: nodeId1,
            target: nodeId2,
            label: 'Hành vi',
            linkStyle: 'solid',
            arrowStyle: 'none',
        };
        onDataChange({
            ...data,
            relationships: [...data.relationships, newRelationship],
        });
        if (navigator.vibrate) {
            navigator.vibrate(50);
        }
    }
  };

  const handleDeleteNodeClick = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const newObjects = data.objects.filter(obj => obj.id !== nodeId);
    const newRelationships = data.relationships.filter(
      rel => rel.source !== nodeId && rel.target !== nodeId
    );
    const newClusters = (data.clusters || []).map(cluster => {
        const newNodeIds = cluster.nodeIds.filter(id => id !== nodeId);
        return { ...cluster, nodeIds: newNodeIds };
    }).filter(cluster => cluster.nodeIds.length > 0);

    onDataChange({ ...data, objects: newObjects, relationships: newRelationships, clusters: newClusters });
    setSelectedItem(null);
  };

  const handleDeletePropertyClick = (e: React.MouseEvent, propertyId: string) => {
    e.stopPropagation();
    const newData = JSON.parse(JSON.stringify(data));
    for(const node of newData.objects) {
        const propIndex = node.properties.findIndex((p: Property) => p.id === propertyId);
        if(propIndex !== -1){
            node.properties.splice(propIndex, 1);
            break;
        }
    }
    onDataChange(newData);
    setSelectedItem(null);
  };
  
  const handleDeleteRelationshipPropertyClick = (e: React.MouseEvent, propertyId: string) => {
    e.stopPropagation();
    // FIX: Refactored to use an immutable update pattern, preventing potential state bugs.
    const [relId] = propertyId.split('::');
    const newData = {
        ...data,
        relationships: data.relationships.map(rel => {
            if (rel.id === relId) {
                return {
                    ...rel,
                    properties: (rel.properties || []).filter(p => p.id !== propertyId)
                };
            }
            return rel;
        })
    };
    onDataChange(newData);
    setSelectedItem(null);
  };

  const handleDeleteRelationshipClick = (e: React.MouseEvent, relationshipId: string) => {
    e.stopPropagation();
    onDataChange({
        ...data,
        relationships: data.relationships.filter(rel => rel.id !== relationshipId)
    });
    setSelectedItem(null);
  };

  const handleDeleteImageClick = (e: React.MouseEvent, imageId: string) => {
    e.stopPropagation();
    const updatedImages = data.images?.filter(img => img.id !== imageId);
    onDataChange({ ...data, images: updatedImages });
    setSelectedItem(null);
  };

  const handleDeleteAnnotationClick = (e: React.MouseEvent, annotationId: string) => {
    e.stopPropagation();
    const updatedAnnotations = data.annotations?.filter(ann => ann.id !== annotationId);
    onDataChange({ ...data, annotations: updatedAnnotations });
    setSelectedItem(null);
  };

  const handleUngroupCluster = (e: React.MouseEvent, clusterId: string) => {
      e.stopPropagation();
      const newData = {
          ...data,
          clusters: (data.clusters || []).filter(c => c.id !== clusterId)
      };
      onDataChange(newData);
      setSelectedItem(null);
  };

  const handleEditClick = (e: React.MouseEvent, item: Selection, initialValue: string) => {
      e.stopPropagation();
      setEditingItem({ ...item, initialValue });
  }

  const handleSaveEdit = (newValue: string) => {
      if (!editingItem) return;
      const { type, key } = editingItem;
      const newData = JSON.parse(JSON.stringify(data));

      if (type === 'node') {
          const node = newData.objects.find((n: DiagramObject) => n.id === key);
          if (node) node.name = newValue;
      } else if (type === 'property') {
          for (const obj of newData.objects) {
              const prop = obj.properties.find((p: Property) => p.id === key);
              if (prop) {
                  prop.name = newValue;
                  break;
              }
          }
      } else if (type === 'relationship') {
          const rel = newData.relationships.find((r: Relationship) => r.id === key);
          if (rel) rel.label = newValue;
      } else if (type === 'relationship-property') {
        for (const rel of newData.relationships) {
            if (!rel.properties) continue;
            const prop = rel.properties.find((p: Property) => p.id === key);
            if (prop) {
                prop.name = newValue;
                break;
            }
        }
      } else if (type === 'cluster') {
        const cluster = newData.clusters.find((c: Cluster) => c.id === key);
        if (cluster) cluster.name = newValue;
      } else if (type === 'annotation') {
        const annotation = newData.annotations.find((a: Annotation) => a.id === key);
        if (annotation) annotation.text = newValue;
      }

      onDataChange(newData);
      setEditingItem(null);
      setSelectedItem(null);
  };

  const handleDuplicateNode = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const nodeToCopy = data.objects.find(n => n.id === nodeId);
    if (!nodeToCopy) return;
    const newId = `${nodeToCopy.id}_copy_${Date.now()}`;
    const newNode: DiagramObject = {
        ...nodeToCopy,
        id: newId,
        name: `${nodeToCopy.name} (Copy)`,
        properties: []
    };
    onDataChange({ ...data, objects: [...data.objects, newNode] });
  };
  
  const handleAddProperty = (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      const newProperty: Property = {
          id: `${nodeId}::${crypto.randomUUID()}`,
          name: 'New Property'
      };
      const newData = JSON.parse(JSON.stringify(data));
      const node = newData.objects.find((n: DiagramObject) => n.id === nodeId);
      if (node) {
          node.properties.push(newProperty);
          onDataChange(newData);
          setSelectedItem({ type: 'property', key: newProperty.id });
          setTimeout(() => {
            setEditingItem({ type: 'property', key: newProperty.id, initialValue: 'New Property' });
          }, 0);
      }
  };
  
  const handleAddRelationshipProperty = (e: React.MouseEvent, relId: string) => {
    e.stopPropagation();
    const newProperty: Property = {
        id: `${relId}::${crypto.randomUUID()}`,
        name: 'tính chất'
    };

    // FIX: Refactored to use an immutable update pattern, which is safer in React and resolves the bug where properties were not being added correctly.
    const newData = {
        ...data,
        relationships: data.relationships.map(rel => {
            if (rel.id === relId) {
                return {
                    ...rel,
                    properties: [...(rel.properties || []), newProperty]
                };
            }
            return rel;
        })
    };

    onDataChange(newData);
    setSelectedItem({ type: 'relationship-property', key: newProperty.id });
    setTimeout(() => {
        setEditingItem({ type: 'relationship-property', key: newProperty.id, initialValue: 'tính chất' });
    }, 0);
  };

  const handleLinkStyleChange = (relId: string, updates: Partial<Relationship>) => {
    const newData = {
        ...data,
        relationships: data.relationships.map(rel => rel.id === relId ? { ...rel, ...updates } : rel)
    };
    onDataChange(newData);
    // Keep the editor open
    setEditingLinkStyle(prev => prev ? { ...prev, ...updates } : null);
  };

  const handleColorChange = (nodeId: string, color: string) => {
    const newObjects = data.objects.map(obj => {
        if (obj.id === nodeId) {
            if (color) {
                return { ...obj, backgroundColor: color };
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { backgroundColor, ...rest } = obj;
                return rest;
            }
        }
        return obj;
    });
    onDataChange({ ...data, objects: newObjects });
  };

  const handleClusterNodesColorChange = (clusterId: string, color: string) => {
    const cluster = data.clusters?.find(c => c.id === clusterId);
    if (!cluster) return;

    const nodeIdsInCluster = new Set(cluster.nodeIds);

    const newObjects = data.objects.map(obj => {
        if (nodeIdsInCluster.has(obj.id)) {
            if (color) {
                return { ...obj, backgroundColor: color };
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { backgroundColor, ...rest } = obj;
                return rest;
            }
        }
        return obj;
    });

    onDataChange({ ...data, objects: newObjects });
  };

  const handleAnnotationColorChange = (annotationId: string, color: string) => {
    const newAnnotations = (data.annotations || []).map(ann => {
        if (ann.id === annotationId) {
            if (color) {
                return { ...ann, backgroundColor: color };
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { backgroundColor, ...rest } = ann;
                return rest;
            }
        }
        return ann;
    });
    onDataChange({ ...data, annotations: newAnnotations });
  };

  const handleImageMouseDown = (e: React.MouseEvent, imageId: string) => {
    e.stopPropagation();
    clearPopups();
    setDraggingImageId(imageId);
    setSelectedItem({ type: 'image', key: imageId });
  };

  const handleResizeHandleMouseDown = (e: React.MouseEvent, image: DiagramImage) => {
      e.stopPropagation();
      clearPopups();
      const svg = svgRef.current;
      if (!svg) return;
      const svgPoint = svg.createSVGPoint();
      svgPoint.x = e.clientX;
      svgPoint.y = e.clientY;
      const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());

      setResizingImage({
          id: image.id,
          initialMouseX: transformedPoint.x,
          initialWidth: image.width,
          initialHeight: image.height,
      });
  };

  const handleGroupNodes = () => {
    if (multiSelectedNodeIds.size < 2) return;
    const newCluster: Cluster = {
        id: crypto.randomUUID(),
        name: 'New Group',
        nodeIds: Array.from(multiSelectedNodeIds),
    };

    const newData = {
        ...data,
        clusters: [...(data.clusters || []), newCluster],
    };
    onDataChange(newData);
    setMultiSelectedNodeIds(new Set());
  };
  
  const infoBoxWidth = Math.min(300, viewBox.width * 0.3);
  const infoBoxPadding = 20;

  // FIX: Added variables to safely check if source/target nodes for the LinkStyleEditor exist before attempting to access their properties. This prevents a potential crash if a node is deleted while its link editor is open.
  const sourceForEditor = editingLinkStyle ? nodesMap[editingLinkStyle.source] : null;
  const targetForEditor = editingLinkStyle ? nodesMap[editingLinkStyle.target] : null;

  return (
    <svg 
      ref={svgRef} 
      className="diagram-svg" 
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      onMouseDown={handleSVGMouseDown}
      onMouseMove={handleMouseMove} 
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleSVGTouchStart}
      onDoubleClick={handleSVGDoubleClick}
    >
      <defs>
        <marker id="arrow-forward" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555" /></marker>
        <marker id="arrow-backward" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 10 0 L 0 5 L 10 10 z" fill="#555" /></marker>
      </defs>

      {/* Static UI Elements (Title, Context, Lesson) */}
      <g className="static-ui">
        {/* Title & Description */}
        <g transform={`translate(${viewBox.x + viewBox.width / 2}, ${viewBox.y + 40})`}>
            <rect 
                className="title-box"
                x={titleBox.x}
                y={titleBox.y}
                width={titleBox.width}
                height={titleBox.height}
                rx="8"
            />
            <text 
                ref={titleTextRef}
                className="title-text"
            >
                {data.title}
            </text>
            <text 
              className="description-text" 
              y={titleBox.y + titleBox.height + 5} 
              dominantBaseline="hanging"
            >
              {data.description}
            </text>
            <foreignObject
                x={-100}
                y={titleBox.y + titleBox.height + 25}
                width="200"
                height="40"
            >
                {/* @ts-ignore */}
                <div className="search-bar-container-svg" xmlns="http://www.w3.org/1999/xhtml">
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Tìm kiếm trong sơ đồ..."
                        value={searchQuery}
                        onChange={(e) => onSearchQueryChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            </foreignObject>
        </g>
        
        {/* Context */}
        <foreignObject x={viewBox.x + infoBoxPadding} y={viewBox.y + infoBoxPadding} width={infoBoxWidth} height="120">
            {/* @ts-ignore */}
            <div className="context-wrapper" xmlns="http://www.w3.org/1999/xhtml">
                <strong>Bối cảnh:</strong> {data.context}
            </div>
        </foreignObject>

        {/* Lesson */}
        <foreignObject x={viewBox.x + viewBox.width - infoBoxWidth - infoBoxPadding} y={viewBox.y + infoBoxPadding} width={infoBoxWidth} height="120">
            {/* @ts-ignore */}
            <div className="lesson-wrapper" xmlns="http://www.w3.org/1999/xhtml">
                <strong>Bài học:</strong> {data.lesson}
            </div>
        </foreignObject>
      </g>
      
      {/* Dynamic Diagram Elements */}
      <g>
          {/* Clusters */}
          {data.clusters?.map(cluster => {
              const bbox = clusterBBoxes.get(cluster.id);
              if (!bbox) return null;
              const isSelected = selectedItem?.type === 'cluster' && selectedItem.key === cluster.id;
              const isEditing = editingItem?.type === 'cluster' && editingItem.key === cluster.id;
              const isDimmed = highlightedIds ? !cluster.nodeIds.some(id => highlightedIds.has(id)) : false;

              return (
                  <g key={cluster.id} className={isDimmed ? 'dimmed' : ''}>
                      <rect
                          className="cluster-rect"
                          x={bbox.x}
                          y={bbox.y}
                          width={bbox.width}
                          height={bbox.height}
                          rx="15"
                          style={{ fill: cluster.backgroundColor || 'rgba(136, 136, 136, 0.1)' }}
                          onMouseDown={(e) => handleClusterMouseDown(e, cluster.id)}
                      />
                      {isEditing ? (
                          <InlineEditor
                              initialValue={cluster.name}
                              onSave={handleSaveEdit}
                              onCancel={() => setEditingItem(null)}
                              x={bbox.x + 10} y={bbox.y + 5} width={150} height={24}
                          />
                      ) : (
                          <text
                              className="cluster-label"
                              x={bbox.x + 20}
                              y={bbox.y + 20}
                              onMouseDown={(e) => handleClusterMouseDown(e, cluster.id)}
                              onClick={(e) => { e.stopPropagation(); setSelectedItem({ type: 'cluster', key: cluster.id }); }}
                          >
                              {cluster.name}
                          </text>
                      )}
                      {isSelected && !isEditing && (
                          <g transform={`translate(${bbox.x + bbox.width}, ${bbox.y})`}>
                              <g
                                  className="action-button"
                                  transform="translate(-22, 22)"
                                  onClick={(e) => handleUngroupCluster(e, cluster.id)}
                              >
{/* FIX: Replaced the `title` attribute with a nested `<title>` element to provide a tooltip, resolving a TypeScript error. */}
                                  <title>Ungroup</title>
                                  <circle r="10" fill="#f44336" />
                                  <text className="action-button-icon" style={{fontSize: '20px'}}>⬚</text>
                              </g>
                              <g
                                  className="action-button"
                                  transform="translate(-48, 22)"
                                  onClick={(e) => handleEditClick(e, { type: 'cluster', key: cluster.id }, cluster.name)}
                              >
{/* FIX: Replaced the `title` attribute with a nested `<title>` element to provide a tooltip, resolving a TypeScript error. */}
                                  <title>Edit Name</title>
                                  <circle r="10" fill={PREDEFINED_COLORS[4]} />
                                  <text className="action-button-icon">✎</text>
                              </g>
                              <g
                                  className="action-button color-picker-button-node"
                                  transform="translate(-74, 22)"
                                  onClick={(e) => { e.stopPropagation(); clearPopups(); setEditingColorClusterId(cluster.id); }}
                              >
{/* FIX: Replaced the `title` attribute with a nested `<title>` element to provide a tooltip, resolving a TypeScript error. */}
                                <title>Change Node Colors</title>
                                <circle r="10" fill={PREDEFINED_COLORS[6]}/>
                                <text className="action-button-icon">🎨</text>
                              </g>
                          </g>
                      )}
                  </g>
              )
          })}

          {/* Images */}
          {data.images?.map(image => {
              const isSelected = selectedItem?.type === 'image' && selectedItem.key === image.id;
              const isDimmed = highlightedIds ? !highlightedIds.has(image.id) : false;
              return (
                  <g key={image.id} transform={`translate(${image.x}, ${image.y})`} className={isDimmed ? 'dimmed' : ''}>
                      <image
                          crossOrigin="anonymous"
                          href={image.src}
                          width={image.width}
                          height={image.height}
                          className="diagram-image"
                          onMouseDown={(e) => handleImageMouseDown(e, image.id)}
                      />
                      {isSelected && (
                          <>
                              <rect
                                  className="resize-handle"
                                  x={image.width - 8}
                                  y={-8}
                                  width="16"
                                  height="16"
                                  onMouseDown={(e) => handleResizeHandleMouseDown(e, image)}
                              />
                              <g
                                  className="action-button delete-button-node"
                                  transform={`translate(0, 0)`}
                                  onClick={(e) => handleDeleteImageClick(e, image.id)}
                              >
                                  <circle r="10" />
                                  <text className="action-button-icon">x</text>
                              </g>
                          </>
                      )}
                  </g>
              )
          })}

          {/* Annotations */}
          {data.annotations?.map(annotation => {
            const isSelected = selectedItem?.type === 'annotation' && selectedItem.key === annotation.id;
            const isEditing = editingItem?.type === 'annotation' && editingItem.key === annotation.id;
            const isDimmed = highlightedIds ? !highlightedIds.has(annotation.id) : false;

            const annotationStyle: React.CSSProperties = {};
            if (annotation.backgroundColor) {
                annotationStyle.backgroundColor = annotation.backgroundColor;
                annotationStyle.borderLeftColor = shadeColor(annotation.backgroundColor, -20);
                annotationStyle.color = getContrastingTextColor(annotation.backgroundColor);
            }

            return (
                <g 
                    key={annotation.id} 
                    transform={`translate(${annotation.x}, ${annotation.y})`} 
                    className={`annotation-group ${isDimmed ? 'dimmed' : ''}`}
                    onMouseDown={(e) => handleAnnotationMouseDown(e, annotation.id)}
                    onDoubleClick={(e) => { e.stopPropagation(); handleEditClick(e, { type: 'annotation', key: annotation.id }, annotation.text) }}
                >
                    {isEditing ? (
                         <InlineEditor
                            initialValue={annotation.text}
                            onSave={handleSaveEdit}
                            onCancel={() => setEditingItem(null)}
                            x={0} y={0} width={annotation.width} height={80}
                            multiline
                         />
                    ) : (
                        <foreignObject width={annotation.width} height={120} style={{overflow: 'visible'}}>
                            {/* @ts-ignore */}
                            <div className={`annotation-text-wrapper ${isSelected ? 'selected' : ''}`} xmlns="http://www.w3.org/1999/xhtml" style={annotationStyle}>
                                {annotation.text}
                            </div>
                        </foreignObject>
                    )}
                    {isSelected && !isEditing && (
                        <g>
                            <g
                                className="action-button delete-button-node"
                                transform="translate(0, 0)"
                                onClick={(e) => handleDeleteAnnotationClick(e, annotation.id)}
                            >
                                <circle r="10" />
                                <text className="action-button-icon">x</text>
                            </g>
                            <g
                                className="action-button color-picker-button-node"
                                transform={`translate(${annotation.width}, 0)`}
                                onClick={(e) => { e.stopPropagation(); clearPopups(); setEditingColorAnnotationId(annotation.id); }}
                            >
{/* FIX: Replaced the `title` attribute with a nested `<title>` element to provide a tooltip, resolving a TypeScript error. */}
                              <title>Change Color</title>
                              <circle r="10" fill={PREDEFINED_COLORS[2]}/>
                              <text className="action-button-icon">🎨</text>
                            </g>
                        </g>
                    )}
                </g>
            );
          })}
          
          {/* Relationships */}
          {showRelationships && data.relationships.map((rel) => {
              const layout = relationshipLayouts.get(rel.id);
              if (!layout) return null;
              const { pathData, labelPosition } = layout;

              const labelWithNumber = `${keywordNumbers.get(rel.label) ?? ''}. ${rel.label}`;
              const isSelected = selectedItem?.type === 'relationship' && selectedItem.key === rel.id;
              const isEditing = editingItem?.type === 'relationship' && editingItem.key === rel.id;
              
              const textWidth = labelWithNumber.length * 5;

              const arrowStyle = rel.arrowStyle || 'forward';
              const markerEnd = (arrowStyle === 'forward' || arrowStyle === 'both') ? 'url(#arrow-forward)' : 'none';
              const markerStart = (arrowStyle === 'backward' || arrowStyle === 'both') ? 'url(#arrow-backward)' : 'none';

              const isDimmed = highlightedIds ? !highlightedIds.has(rel.id) : false;

              return (
                  <g key={rel.id} className={isDimmed ? 'dimmed' : ''}>
                      <path 
                          d={pathData} 
                          className="link-line" 
                          markerEnd={markerEnd}
                          markerStart={markerStart}
                          strokeDasharray={rel.linkStyle === 'dashed' ? '5,5' : 'none'}
                          onClick={() => { clearPopups(); setEditingLinkStyle(rel); setLinkingNodeId(null); }}
                      />
                      {isEditing ? (
                          <InlineEditor 
                              initialValue={rel.label}
                              onSave={handleSaveEdit}
                              onCancel={() => setEditingItem(null)}
                              x={labelPosition.x - 50} y={labelPosition.y - 12} width={100} height={24}
                          />
                      ) : (
                          <g 
                            className="relationship-label-group" 
                            transform={`translate(${labelPosition.x}, ${labelPosition.y})`} 
                            onMouseDown={(e) => handleRelationshipMouseDown(e, rel.id)}
                            onClick={(e) => { e.stopPropagation(); clearPopups(); setSelectedItem({ type: 'relationship', key: rel.id }); setLinkingNodeId(null); }}
                          >
                            <rect x={-textWidth/2 - 2} y={-10} width={textWidth + 4} height={15} fill="var(--surface-color)"/>
                            <text className="link-label">{labelWithNumber}</text>
                          </g>
                      )}
                       {isSelected && !isEditing && (
                          <g transform={`translate(${labelPosition.x}, ${labelPosition.y})`}>
                              <g
                                className="action-button delete-button"
                                transform={`translate(${-textWidth/2 - 12}, 0)`}
                                onClick={(e) => handleDeleteRelationshipClick(e, rel.id)}
                              >
                                  <circle r="8" />
                                  <text className="action-button-icon">x</text>
                              </g>
                              <text 
                                  className="action-button edit-icon" 
                                  x={textWidth/2 + 12} 
                                  onClick={(e) => handleEditClick(e, {type: 'relationship', key: rel.id}, rel.label)}
                              >✎</text>
                              <g
                                  className="action-button add-button-node"
                                  transform="translate(0, -18)"
                                  onClick={(e) => handleAddRelationshipProperty(e, rel.id)}
                                >
                                  <circle r="8" />
                                  <text className="action-button-icon">+</text>
                                </g>
                          </g>
                      )}
                      {/* Relationship Properties */}
                      {showProperties && rel.properties?.map(prop => {
                          const key = prop.id;
                          const pos = relationshipPropertyPositions[key];
                          if (!pos) return null;

                          const propX = labelPosition.x + pos.x;
                          const propY = labelPosition.y + pos.y;
                          
                          const textAnchor = pos.x < -1 ? 'end' : pos.x > 1 ? 'start' : 'middle';
                          const labelWithNumber = `${keywordNumbers.get(prop.name) ?? ''}. ${prop.name}`;
                          
                          const propIsSelected = selectedItem?.type === 'relationship-property' && selectedItem.key === key;
                          const propIsEditing = editingItem?.type === 'relationship-property' && editingItem.key === key;
                          const textWidth = labelWithNumber.length * 5.5;
                          const propIsDimmed = highlightedIds ? !highlightedIds.has(key) : false;

                          return (
                              <g 
                                key={key} 
                                className={`property-group ${propIsDimmed ? 'dimmed' : ''}`}
                                onMouseDown={(e) => handleRelationshipPropertyMouseDown(e, key)}
                              >
                                  <line x1={labelPosition.x} y1={labelPosition.y} x2={propX} y2={propY} className="property-line" />
                                  {propIsEditing ? (
                                      <InlineEditor
                                        initialValue={prop.name}
                                        onSave={handleSaveEdit}
                                        onCancel={() => setEditingItem(null)}
                                        x={propX - (textAnchor === 'end' ? 100 : 0)} y={propY - 12} width={100} height={24}
                                      />
                                  ) : (
                                      <text 
                                        x={propX} y={propY} 
                                        className="property-label" 
                                        style={{ textAnchor, dominantBaseline: 'middle' }}
                                        onClick={(e) => { e.stopPropagation(); setSelectedItem({ type: 'relationship-property', key }); clearPopups(); setLinkingNodeId(null); }}
                                      >
                                      {labelWithNumber}
                                      </text>
                                  )}
                                  {propIsSelected && !propIsEditing && (
                                        <g transform={`translate(${propX + (textAnchor === 'end' ? -textWidth -5 : 5)}, ${propY})`}>
                                            <g
                                                className="action-button delete-button"
                                                onClick={(e) => handleDeleteRelationshipPropertyClick(e, key)}
                                            >
                                                <circle r="8" />
                                                <text className="action-button-icon">x</text>
                                            </g>
                                            <text
                                                className="action-button edit-icon"
                                                x={textAnchor === 'start' ? textWidth + 24 : -12}
                                                onClick={(e) => handleEditClick(e, {type: 'relationship-property', key}, prop.name)}
                                            >✎</text>
                                        </g>
                                    )}
                              </g>
                          );
                      })}
                  </g>
              );
            })}


          {/* Objects and Properties */}
          {nodes.map(node => {
            const nodeDims = nodeDimensions.get(node.id) || { width: 80, height: 40 };
            const isSelected = selectedItem?.type === 'node' && selectedItem.key === node.id;
            const isMultiSelected = multiSelectedNodeIds.has(node.id);
            const isEditing = editingItem?.type === 'node' && editingItem.key === node.id;
            const isDimmed = highlightedIds ? !highlightedIds.has(node.id) : false;
            
            return (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`} className={isDimmed ? 'dimmed' : ''}>
              {showProperties && node.properties.map((prop) => {
                  const key = prop.id;
                  const pos = propertyPositions[key];
                  if (!pos) return null;

                  const startPoint = getRectangleIntersection({x: 0, y: 0}, pos, nodeDims);
                  const textAnchor = pos.x < -1 ? 'end' : pos.x > 1 ? 'start' : 'middle';
                  const labelWithNumber = `${keywordNumbers.get(prop.name) ?? ''}. ${prop.name}`;
                  
                  const propIsSelected = selectedItem?.type === 'property' && selectedItem.key === key;
                  const propIsEditing = editingItem?.type === 'property' && editingItem.key === key;

                  const textWidth = labelWithNumber.length * 5.5;
                  const propIsDimmed = highlightedIds ? !highlightedIds.has(key) : false;

                  return (
                      <g 
                        key={key} 
                        className={`property-group ${propIsDimmed ? 'dimmed' : ''}`}
                        onMouseDown={(e) => handlePropertyMouseDown(e, key)}
                      >
                          <line x1={startPoint.x} y1={startPoint.y} x2={pos.x} y2={pos.y} className="property-line" />
                           {propIsEditing ? (
                               <InlineEditor
                                  initialValue={prop.name}
                                  onSave={handleSaveEdit}
                                  onCancel={() => setEditingItem(null)}
                                  x={pos.x - (textAnchor === 'end' ? 100 : 0)} y={pos.y - 12} width={100} height={24}
                               />
                           ) : (
                               <text 
                                  x={pos.x} y={pos.y} 
                                  className="property-label" 
                                  style={{ textAnchor, dominantBaseline: 'middle' }}
                                  onClick={(e) => { e.stopPropagation(); setSelectedItem({ type: 'property', key }); clearPopups(); setLinkingNodeId(null); }}
                               >
                                {labelWithNumber}
                               </text>
                           )}
                           {propIsSelected && !propIsEditing && (
                                <g transform={`translate(${pos.x + (textAnchor === 'end' ? -textWidth -5 : 5)}, ${pos.y})`}>
                                    <g
                                        className="action-button delete-button"
                                        transform={`translate(0, 0)`}
                                        onClick={(e) => handleDeletePropertyClick(e, key)}
                                    >
                                        <circle r="8" />
                                        <text className="action-button-icon">x</text>
                                    </g>
                                    <text
                                        className="action-button edit-icon"
                                        x={textAnchor === 'start' ? textWidth + 24 : -12}
                                        onClick={(e) => handleEditClick(e, {type: 'property', key}, prop.name)}
                                    >✎</text>
                                </g>
                            )}
                      </g>
                  );
              })}
              <rect
                className={`node-rect ${linkingNodeId === node.id ? 'linking' : ''} ${isMultiSelected ? 'multi-selected' : ''}`}
                x={-nodeDims.width / 2}
                y={-nodeDims.height / 2}
                width={nodeDims.width}
                height={nodeDims.height}
                rx="5"
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)} 
                style={{ fill: node.backgroundColor }}
              />
              {isEditing ? (
                  <InlineEditor 
                      initialValue={node.name}
                      onSave={handleSaveEdit}
                      onCancel={() => setEditingItem(null)}
                      x={-nodeDims.width / 2 + 5} y={-12} width={nodeDims.width - 10} height={24}
                  />
              ) : (
                <text className="node-label" y="5" onClick={(e) => { e.stopPropagation(); setSelectedItem({ type: 'node', key: node.id }); clearPopups(); setLinkingNodeId(null); }}>{node.name}</text>
              )}
              <text className="node-number" x={-nodeDims.width / 2 + 8} y={-nodeDims.height / 2 + 12}>
                  {keywordNumbers.get(node.name) ?? ''}
              </text>

              {isSelected && !isEditing && (
                <g>
                    <g 
                      className="action-button delete-button-node" 
                      transform={`translate(${-nodeDims.width / 2}, ${-nodeDims.height / 2})`}
                      onClick={(e) => handleDeleteNodeClick(e, node.id)}
                    >
                        <circle r="10" />
                        <text className="action-button-icon">x</text>
                    </g>
                    <g
                        className="action-button edit-button-node"
                        transform={`translate(${nodeDims.width / 2}, ${-nodeDims.height / 2})`}
                        onClick={(e) => handleEditClick(e, {type: 'node', key: node.id}, node.name)}
                    >
                      <circle r="10" />
                      <text className="action-button-icon">✎</text>
                    </g>
                    <g
                        className="action-button add-button-node"
                        transform={`translate(${-nodeDims.width / 2}, ${nodeDims.height / 2})`}
                        onClick={(e) => handleAddProperty(e, node.id)}
                    >
                      <circle r="10" />
                      <text className="action-button-icon">+</text>
                    </g>
                    <g
                        className="action-button duplicate-button-node"
                        transform={`translate(${nodeDims.width / 2}, ${nodeDims.height / 2})`}
// FIX: Corrected a reference error where `nodeId` was used instead of `node.id` within the `nodes.map` loop, causing the duplicate button to fail.
                        onClick={(e) => handleDuplicateNode(e, node.id)}
                    >
                      <circle r="10" />
                      <text className="action-button-icon">❐</text>
                    </g>
                    <g
                        className="action-button color-picker-button-node"
                        transform={`translate(0, ${nodeDims.height / 2})`}
                        onClick={(e) => { e.stopPropagation(); clearPopups(); setEditingColorNodeId(node.id); }}
                    >
                      <circle r="10" />
                      <text className="action-button-icon">🎨</text>
                    </g>
                </g>
              )}
            </g>
          )})}
           {editingLinkStyle && sourceForEditor && targetForEditor && <LinkStyleEditor
              relationship={editingLinkStyle}
              position={{ x: (sourceForEditor.x + targetForEditor.x) / 2 - 90, y: (sourceForEditor.y + targetForEditor.y) / 2 + 20 }}
              onStyleChange={handleLinkStyleChange}
              onClose={() => setEditingLinkStyle(null)}
          />}
          {editingColorNodeId && nodesMap[editingColorNodeId] && (() => {
                const node = nodesMap[editingColorNodeId];
                const nodeDims = nodeDimensions.get(node.id) || { width: 80, height: 40 };
                const position = {
                    x: node.x - 65,
                    y: node.y + nodeDims.height / 2 + 15,
                };
                return (
                    <ColorPicker
                        position={position}
                        onColorChange={(color) => handleColorChange(node.id, color)}
                        onClose={() => setEditingColorNodeId(null)}
                    />
                );
          })()}
          {editingColorClusterId && (() => {
                const bbox = clusterBBoxes.get(editingColorClusterId);
                if (!bbox) return null;
                const position = {
                    x: bbox.x + bbox.width / 2 - 65,
                    y: bbox.y + 40,
                };
                return (
                    <ColorPicker
                        position={position}
                        onColorChange={(color) => handleClusterNodesColorChange(editingColorClusterId, color)}
                        onClose={() => setEditingColorClusterId(null)}
                    />
                );
          })()}
          {editingColorAnnotationId && (() => {
                const annotation = data.annotations?.find(a => a.id === editingColorAnnotationId);
                if (!annotation) return null;
                const position = {
                    x: annotation.x + annotation.width / 2 - 65,
                    y: annotation.y + 30,
                };
                return (
                    <ColorPicker
                        position={position}
                        onColorChange={(color) => handleAnnotationColorChange(annotation.id, color)}
                        onClose={() => setEditingColorAnnotationId(null)}
                    />
                );
          })()}
          {multiSelectBBox && (
              <foreignObject x={multiSelectBBox.x - 50} y={multiSelectBBox.y - 20} width={100} height={40}>
                  {/* @ts-ignore */}
                  <div className="floating-action-bar" xmlns="http://www.w3.org/1999/xhtml">
                      <button title="Group Nodes" onClick={handleGroupNodes}>
                          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg> Group
                      </button>
                  </div>
              </foreignObject>
          )}
      </g>
    </svg>
  );
});


// --- Main App Component ---
function App() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [text, setText] = useState('');
  const { 
    currentState: diagramData, 
    setState: setDiagramData, 
    undo, 
    redo, 
    canUndo, 
    canRedo,
    resetState 
  } = useHistoryState<EnrichedDiagramData | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagramKey, setDiagramKey] = useState(Date.now());
  const [searchQuery, setSearchQuery] = useState('');
  const [initialLayout, setInitialLayout] = useState<LayoutData | null>(null);

  const [isMermaidModalOpen, setIsMermaidModalOpen] = useState(false);
  const [mermaidCode, setMermaidCode] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [showProperties, setShowProperties] = useState(true);
  const [showRelationships, setShowRelationships] = useState(true);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  
  const diagramRef = useRef<DiagramRef>(null);
  const outputContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Handle clicks outside export menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
        if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
            setIsExportMenuOpen(false);
        }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
        document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Keyboard shortcuts for Undo/Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

      if (ctrlOrCmd && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          if (canRedo) redo();
        } else {
          if (canUndo) undo();
        }
      } else if (ctrlOrCmd && e.key.toLowerCase() === 'y' && !isMac) {
        e.preventDefault();
        if (canRedo) redo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [undo, redo, canUndo, canRedo]);

  const { diagramToRender, highlightedIds } = useMemo(() => {
    if (!diagramData?.data) return { diagramToRender: null, highlightedIds: null };

    // When searching, we keep the original data to preserve the layout,
    // and we compute a set of IDs to highlight. Items not in the set will be dimmed.
    const data = diagramData.data;

    const normalizeString = (str: string) => {
        if (!str) return '';
        return str
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    };
  
    const query = normalizeString(searchQuery.trim());
    if (!query) {
      // No search query, so render all data and no highlights
      return { diagramToRender: data, highlightedIds: null };
    }
  
    const initialHighlights = new Set<string>();
  
    // Step 1: Find direct matches and add them (+ their parents) to the initial highlight set.
    data.objects.forEach(obj => {
      // Match object name
      if (normalizeString(obj.name).includes(query)) {
        initialHighlights.add(obj.id);
      }
      // Match property name
      obj.properties.forEach(prop => {
        if (normalizeString(prop.name).includes(query)) {
          initialHighlights.add(prop.id);
          initialHighlights.add(obj.id); // Also highlight the parent object
        }
      });
    });
  
    data.relationships.forEach(rel => {
      // Match relationship label
      if (normalizeString(rel.label).includes(query)) {
        initialHighlights.add(rel.id);
      }
      // Match relationship property name
      (rel.properties || []).forEach(prop => {
        if (normalizeString(prop.name).includes(query)) {
          initialHighlights.add(prop.id);
          initialHighlights.add(rel.id); // Also highlight the parent relationship
        }
      });
    });

    data.annotations?.forEach(ann => {
        if (normalizeString(ann.text).includes(query)) {
            initialHighlights.add(ann.id);
        }
    });

    data.clusters?.forEach(cluster => {
        if (normalizeString(cluster.name).includes(query)) {
            // If a cluster name matches, highlight all nodes within it.
            cluster.nodeIds.forEach(nodeId => initialHighlights.add(nodeId));
        }
    });

    // Step 2: Propagate highlights to directly connected items.
    const finalHighlights = new Set<string>(initialHighlights);
    data.relationships.forEach(rel => {
        const sourceWasMatched = initialHighlights.has(rel.source);
        const targetWasMatched = initialHighlights.has(rel.target);
        const relWasMatched = initialHighlights.has(rel.id);

        // If any part of a relationship trio was a direct match, highlight the other parts.
        if (sourceWasMatched) {
            finalHighlights.add(rel.id);
            finalHighlights.add(rel.target);
        }
        if (targetWasMatched) {
            finalHighlights.add(rel.id);
            finalHighlights.add(rel.source);
        }
        if (relWasMatched) {
            finalHighlights.add(rel.source);
            finalHighlights.add(rel.target);
        }
    });

    return { diagramToRender: data, highlightedIds: finalHighlights };
  }, [diagramData, searchQuery]);

  const processAndGenerateDiagram = async (textToProcess: string, signal: AbortSignal): Promise<EnrichedDiagramData | null> => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      
    const schema = {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Tiêu đề của văn bản" },
        context: { type: Type.STRING, description: "Bối cảnh chung (không gian, thời gian, tình huống)." },
        lesson: { type: Type.STRING, description: "Bài học hoặc ứng dụng có thể rút ra từ văn bản." },
        objects: {
          type: Type.ARRAY,
          description: "Danh sách các đối tượng/thực thể chính.",
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: "ID duy nhất, viết liền, không dấu, ví dụ: 'doi_tuong_1'" },
              name: { type: Type.STRING, description: "Tên của đối tượng." },
              properties: {
                type: Type.ARRAY,
                description: "Danh sách các tính chất, thuộc tính của đối tượng.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Tên của tính chất." },
                  },
                  required: ["name"],
                }
              }
            },
            required: ["id", "name", "properties"]
          }
        },
        relationships: {
          type: Type.ARRAY,
          description: "Danh sách các mối quan hệ, hành vi giữa các đối tượng.",
          items: {
            type: Type.OBJECT,
            properties: {
              source: { type: Type.STRING, description: "ID của đối tượng nguồn." },
              target: { type: Type.STRING, description: "ID của đối tượng đích." },
              label: { type: Type.STRING, description: "Mô tả hành vi/mối quan hệ." }
            },
            required: ["source", "target", "label"]
          }
        }
      },
      required: ["title", "context", "lesson", "objects", "relationships"]
    };

    const prompt = `Phân tích văn bản sau đây để tạo một sơ đồ tư duy hệ thống. Sơ đồ phải tuân theo 5 thành phần: Đối tượng, Tính chất, Hành vi, Bối cảnh, và Bài học.
    - Đối tượng: Các thực thể, nhân vật, sự vật chính trong văn bản.
    - Tính chất: Các đặc điểm, thuộc tính mô tả đối tượng.
    - Hành vi: Các hành động, tương tác, mối liên hệ giữa các đối tượng.
    - Bối cảnh: Không gian, thời gian, hoặc tình huống chung của văn bản.
    - Bài học: Bài học kinh nghiệm hoặc ứng dụng thực tế có thể rút ra từ nội dung.
    
    Hãy xác định các thành phần này và trả về kết quả dưới dạng một đối tượng JSON duy nhất, tuân thủ nghiêm ngặt schema đã cung cấp.
    
    Tiêu đề: "${title}"
    Nội dung văn bản: "${textToProcess}"
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    if (signal.aborted) {
      return null;
    }
    
    const responseText = response.text.trim();
    const parsedData: any = JSON.parse(responseText);
    
    parsedData.description = description;

    parsedData.relationships.forEach((rel: Relationship) => {
      rel.id = crypto.randomUUID();
      rel.arrowStyle = 'forward';
      rel.linkStyle = 'solid';
    });
    if (Array.isArray(parsedData.objects)) {
      parsedData.objects.forEach((obj: any) => {
        const properties = Array.isArray(obj.properties) ? obj.properties : [];
        obj.properties = properties.map((prop: any) => ({
          id: `${obj.id}::${crypto.randomUUID()}`,
          name: prop?.name || ''
        }));
      });
    }

    const keywordNumbers = new Map<string, number>();
    let keywordCounter = 1;
    const addKeyword = (keyword: string) => {
      if (keyword && !keywordNumbers.has(keyword)) {
          keywordNumbers.set(keyword, keywordCounter++);
      }
    };

    if (Array.isArray(parsedData.objects)) {
        (parsedData as DiagramData).objects.forEach(obj => {
            addKeyword(obj.name);
            if (Array.isArray(obj.properties)) {
              obj.properties.forEach(prop => addKeyword(prop.name));
            }
        });
    }
    if (Array.isArray(parsedData.relationships)) {
        (parsedData as DiagramData).relationships.forEach(rel => {
            addKeyword(rel.label);
        });
    }
    
    return { data: parsedData as DiagramData, keywordNumbers };
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text || isLoading) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);
    resetState(null);
    setInitialLayout(null);

    try {
      const result = await processAndGenerateDiagram(text, controller.signal);
      if (result) {
          resetState(result);
          setDiagramKey(Date.now());
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(err);
        setError('Đã xảy ra lỗi khi tạo sơ đồ. Vui lòng kiểm tra nội dung và thử lại.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateSummaryDiagram = async () => {
    if (!text || isLoading) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);
    resetState(null);
    setInitialLayout(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const summaryPrompt = `Tóm tắt ngắn gọn và súc tích văn bản sau đây để lấy ý chính, phục vụ cho việc tạo sơ đồ hệ thống. Giữ lại các đối tượng, hành vi và thông tin quan trọng nhất. Văn bản: "${text}"`;
      
      const summaryResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: summaryPrompt,
      });

      if (controller.signal.aborted) return;

      const summaryText = summaryResponse.text;

      const result = await processAndGenerateDiagram(summaryText, controller.signal);
      if (result) {
          resetState(result);
          setDiagramKey(Date.now());
      }

    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(err);
        setError('Đã xảy ra lỗi khi tạo sơ đồ tóm tắt. Vui lòng thử lại.');
      }
    } finally {
      setIsLoading(false);
    }
  };


  const handlePause = () => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    setIsLoading(false);
    setError("Quá trình tạo sơ đồ đã được dừng.");
  };
  
  const exportToPng = () => {
    const svg = diagramRef.current?.getSvgElement();
    if (!svg) return;

    const staticUi = svg.querySelector('.static-ui');
    const dynamicContent = staticUi?.nextElementSibling;
    if(!dynamicContent) return;

    const bbox = (dynamicContent as SVGGElement).getBBox();
    if (bbox.width === 0 || bbox.height === 0) {
        alert("Không thể xuất file PNG: Sơ đồ không có nội dung để hiển thị.");
        return;
    }

    const padding = 50;
    const topPadding = 150; // Extra padding for top elements

    const tempSvg = svg.cloneNode(true) as SVGSVGElement;
    
    // Position static UI relative to the bounding box for export
    const titleGroup = tempSvg.querySelector('.static-ui g');
    if(titleGroup) titleGroup.setAttribute('transform', `translate(${bbox.x + bbox.width / 2}, ${bbox.y - padding - 20})`);
    
    const contextFo = tempSvg.querySelectorAll('.static-ui foreignObject')[0];
    if(contextFo) {
        contextFo.setAttribute('x', `${bbox.x - padding}`);
        contextFo.setAttribute('y', `${bbox.y - topPadding}`);
    }
    const lessonFo = tempSvg.querySelectorAll('.static-ui foreignObject')[1];
    if(lessonFo) {
        // FIX: Convert the 'width' attribute string to a number before performing subtraction.
        lessonFo.setAttribute('x', `${bbox.x + bbox.width + padding - parseInt(lessonFo.getAttribute('width') || '0', 10)}`);
        lessonFo.setAttribute('y', `${bbox.y - topPadding}`);
    }


    const finalWidth = bbox.width + padding * 2;
    const finalHeight = bbox.height + topPadding + padding;

    tempSvg.setAttribute('viewBox', `${bbox.x - topPadding} ${bbox.y - topPadding} ${finalWidth} ${finalHeight}`);
    tempSvg.setAttribute('width', `${finalWidth}`);
    tempSvg.setAttribute('height', `${finalHeight}`);
    
    const styles = `
      .link-line { stroke: #555; stroke-width: 1.5px; fill: none; }
      .link-label { fill: #03dac6; font-size: 10px; text-anchor: middle; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      .node-rect { stroke: #bb86fc; stroke-width: 2px; fill: #1e1e1e; }
      .node-label { fill: #e0e0e0; font-size: 12px; font-weight: 500; text-anchor: middle; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      .node-number { font-size: 10px; fill: #03dac6; font-weight: bold; }
      .property-line { stroke: #444; stroke-width: 1px; }
      .property-label { fill: #aaa; font-size: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; dominant-baseline: middle; }
      .title-box { fill: rgba(187, 134, 252, 0.1); stroke: #bb86fc; }
      .title-text { font-size: 18px; font-weight: bold; fill: #e0e0e0; text-anchor: middle; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      .description-text { font-size: 12px; fill: #aaa; text-anchor: middle; }
      .context-wrapper, .lesson-wrapper { height: auto; word-wrap: break-word; font-size: 11px; font-style: italic; border-radius: 5px; padding: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding-bottom: 12px; border-bottom: 2px solid; }
      .context-wrapper { color: #03dac6; background-color: rgba(3, 218, 198, 0.1); border-color: #03dac6; }
      .lesson-wrapper { color: #bb86fc; background-color: rgba(187, 134, 252, 0.1); border-color: #bb86fc; }
      .cluster-rect { fill: rgba(136, 136, 136, 0.1); stroke: #888; stroke-width: 1px; stroke-dasharray: 10 5; }
      .cluster-label { font-size: 14px; font-weight: bold; fill: #aaa; }
      .annotation-text-wrapper { background-color: rgba(255, 229, 100, 0.15); color: #fce883; font-size: 11px; padding: 8px; border-radius: 4px; border-left: 3px solid #fce883; width: 100%; height: auto; user-select: none; word-wrap: break-word; }
      strong { font-weight: bold; display: block; margin-bottom: 4px; }
      g.dimmed { opacity: 0.1 !important; }
    `;

    const svgString = new XMLSerializer().serializeToString(tempSvg);
    const styledSvgString = svgString.replace('</defs>', `</defs><style>${styles}</style>`);
    
    // FIX: Convert the SVG string to a base64 data URL instead of a blob URL. This avoids a browser security issue ("tainted canvas")
    // that can occur when an SVG containing embedded images (from data URLs) is loaded from a blob URL into a canvas for export.
    const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(styledSvgString)));
    
    const img = new Image();
    img.onload = () => {
      const scaleFactor = 2; // Double the resolution
      const canvas = document.createElement('canvas');
      canvas.width = finalWidth * scaleFactor;
      canvas.height = finalHeight * scaleFactor;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pngUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = 'system-diagram.png';
        a.click();
      }
    };
    img.src = svgDataUrl;
  };

  const handleExportJson = () => {
    if (!diagramData) return;
    const jsonString = JSON.stringify(diagramData.data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram-data.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const generateMermaidCode = () => {
    if (!diagramData) return '';
    let mermaidString = 'graph TD;\n';
    
    // Handle clusters with subgraphs
    const nodeToClusterMap = new Map<string, string>();
    diagramData.data.clusters?.forEach(cluster => {
        cluster.nodeIds.forEach(nodeId => {
            nodeToClusterMap.set(nodeId, cluster.id);
        });
    });

    diagramData.data.clusters?.forEach(cluster => {
        mermaidString += `  subgraph ${cluster.id} ["${cluster.name}"]\n`;
        cluster.nodeIds.forEach(nodeId => {
            const obj = diagramData.data.objects.find(o => o.id === nodeId);
            if(obj) {
                const nodeText = `${obj.name}`.replace(/"/g, '#quot;');
                mermaidString += `    ${obj.id}["${nodeText}"];\n`;
            }
        });
        mermaidString += '  end\n';
    });

    // Add nodes not in any cluster
    diagramData.data.objects.forEach(obj => {
        if (!nodeToClusterMap.has(obj.id)) {
            const nodeText = `${obj.name}`.replace(/"/g, '#quot;');
            mermaidString += `  ${obj.id}["${nodeText}"];\n`;
        }
    });

    diagramData.data.relationships.forEach(rel => {
        const label = String(rel?.label ?? '').replace(/"/g, '#quot;');
        mermaidString += `  ${rel.source} -- "${label}" --> ${rel.target};\n`;
    });
    return mermaidString;
  };

  const handleOpenMermaidModal = () => {
    setMermaidCode(generateMermaidCode());
    setIsMermaidModalOpen(true);
  };
  
  const toggleFullscreen = () => {
    if (!outputContainerRef.current) return;
    if (!document.fullscreenElement) {
      outputContainerRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const handleDataChange = (updatedData: DiagramData) => {
    if (!diagramData) return;
    const keywordNumbers = new Map<string, number>();
    let keywordCounter = 1;
    const addKeyword = (keyword: string) => {
        if (keyword && !keywordNumbers.has(keyword)) {
            keywordNumbers.set(keyword, keywordCounter++);
        }
    };
    updatedData.objects.forEach(obj => {
        addKeyword(obj.name);
        // FIX: Ensure obj.properties is an array before iterating. This prevents errors if the API returns a non-array value.
        if (Array.isArray(obj.properties)) {
            obj.properties.forEach(prop => addKeyword(prop.name));
        }
    });
    updatedData.relationships.forEach(rel => {
        addKeyword(rel.label);
        if (Array.isArray(rel.properties)) {
          rel.properties.forEach(prop => addKeyword(prop.name));
      }
    });
    setDiagramData({ data: updatedData, keywordNumbers });
  };

  const handleAddImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && diagramData) {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const svg = diagramRef.current?.getSvgElement();
                const vb = svg?.viewBox?.baseVal || { x: 0, y: 0, width: svg?.clientWidth || 800, height: svg?.clientHeight || 600 };
                const newImage: DiagramImage = {
                    id: crypto.randomUUID(),
                    src: event.target?.result as string,
                    x: vb.x + vb.width / 2 - 100,
                    y: vb.y + vb.height / 2 - 75,
                    width: 200,
                    height: (200 / img.width) * img.height,
                };
                const newData = {
                    ...diagramData.data,
                    images: [...(diagramData.data.images || []), newImage],
                };
                handleDataChange(newData);
            };
            img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
    }
    if (e.target) e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/') && diagramData) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const svg = diagramRef.current?.getSvgElement();
          if (!svg) return;
          
          const svgPoint = svg.createSVGPoint();
          svgPoint.x = e.clientX;
          svgPoint.y = e.clientY;
          const transformedPoint = svgPoint.matrixTransform(svg.getScreenCTM()?.inverse());
          
          const baseWidth = 200;
          const newImage: DiagramImage = {
            id: crypto.randomUUID(),
            src: event.target?.result as string,
            x: transformedPoint.x - baseWidth / 2,
            y: transformedPoint.y - ((baseWidth / img.width) * img.height) / 2,
            width: baseWidth,
            height: (baseWidth / img.width) * img.height,
          };
          const newData = {
            ...diagramData.data,
            images: [...(diagramData.data.images || []), newImage],
          };
          handleDataChange(newData);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleImportClick = () => {
    importFileInputRef.current?.click();
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const jsonString = event.target?.result as string;
            const importedData: DiagramData = JSON.parse(jsonString);

            // Basic validation
            if (!importedData.objects || !importedData.relationships || !importedData.title) {
                throw new Error("Invalid diagram file format.");
            }
            
            // Process and set state
            const keywordNumbers = new Map<string, number>();
            let keywordCounter = 1;
            const addKeyword = (keyword: string) => {
                if (keyword && !keywordNumbers.has(keyword)) {
                    keywordNumbers.set(keyword, keywordCounter++);
                }
            };
            importedData.objects.forEach(obj => {
                addKeyword(obj.name);
                if (Array.isArray(obj.properties)) {
                    obj.properties.forEach(prop => addKeyword(prop.name));
                }
            });
            importedData.relationships.forEach(rel => {
                addKeyword(rel.label);
                if (Array.isArray(rel.properties)) {
                    rel.properties.forEach(prop => addKeyword(prop.name));
                }
            });

            const enrichedData: EnrichedDiagramData = { data: importedData, keywordNumbers };
            
            // Update form fields
            setTitle(importedData.title);
            setDescription(importedData.description);
            setText(''); // Clear the text input as the diagram is loaded directly

            // Reset diagram state
            resetState(enrichedData);
            setInitialLayout(null); // Force simulation
            setDiagramKey(Date.now());
            setError(null);

        } catch (err) {
            console.error("Failed to import JSON:", err);
            setError("Không thể nhập tệp. Vui lòng đảm bảo đó là tệp JSON sơ đồ hợp lệ.");
        }
    };
    reader.onerror = () => {
         setError("Lỗi khi đọc tệp.");
    };
    reader.readAsText(file);

    // Clear the input value to allow re-importing the same file
    if (e.target) e.target.value = '';
  };

  return (
    <main>
      <header className="header">
        <h1>Trình tạo Sơ đồ Tư duy Hệ thống</h1>
        <p>Biến văn bản (bài báo, câu chuyện) thành một sơ đồ trực quan dựa trên phương pháp tư duy hệ thống.</p>
      </header>

      <form className="form-container" onSubmit={handleGenerate}>
        <div className="input-group">
            <label htmlFor="title-input">Tiêu đề nội dung</label>
            <input 
                id="title-input"
                type="text" 
                className="input-field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ví dụ: Rùa và Thỏ"
                disabled={isLoading}
            />
        </div>
        <div className="input-group">
            <label htmlFor="description-input">Mô tả (tùy chọn)</label>
            <textarea
                id="description-input"
                className="textarea-field description-field"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Thêm mô tả ngắn gọn cho sơ đồ..."
                disabled={isLoading}
            />
        </div>
        <div className="input-group">
            <label htmlFor="text-input">Nội dung văn bản</label>
            <textarea
                id="text-input"
                className="textarea-field"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Dán nội dung bài báo, câu chuyện vào đây..."
                required
                disabled={isLoading}
            />
        </div>
        <div className="form-actions">
          <button type="submit" className="submit-button" disabled={isLoading || !text}>
            {isLoading ? 'Đang xử lý...' : 'Tạo sơ đồ'}
          </button>
          <button type="button" className="submit-button" onClick={handleGenerateSummaryDiagram} disabled={isLoading || !text}>
            Tạo sơ đồ tóm tắt
          </button>
          {isLoading && (
            <button type="button" className="pause-button" onClick={handlePause}>
              Ngừng xử lý
            </button>
          )}
        </div>
      </form>

      <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleImageUpload}
          accept="image/*"
      />
      <input
          type="file"
          ref={importFileInputRef}
          style={{ display: 'none' }}
          onChange={handleImportJson}
          accept="application/json"
      />

      <div 
        ref={outputContainerRef} 
        className="output-container"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingOver && (
            <div className="drop-overlay">
                <p>Thả ảnh vào đây</p>
            </div>
        )}
        {diagramData && !isLoading && (
          <>
            <div className="vertical-toolbar">
              <button onClick={undo} className="control-button" title="Undo (Ctrl+Z)" disabled={!canUndo}>↺</button>
              <button onClick={redo} className="control-button" title="Redo (Ctrl+Y)" disabled={!canRedo}>↻</button>
              <div className="separator" />
              <button onClick={handleAddImageClick} className="control-button" title="Add Image">+</button>
              <div className="export-dropdown-container" ref={exportMenuRef}>
                  <button onClick={() => setIsExportMenuOpen(!isExportMenuOpen)} className="control-button" title="Export">
                    📥
                  </button>
                  {isExportMenuOpen && (
                    <div className="export-dropdown-menu">
                      <button onClick={() => { exportToPng(); setIsExportMenuOpen(false); }}>Export PNG</button>
                      <button onClick={() => { handleExportJson(); setIsExportMenuOpen(false); }}>Export JSON</button>
                      <button onClick={() => { handleOpenMermaidModal(); setIsExportMenuOpen(false); }}>Export Mermaid</button>
                    </div>
                  )}
              </div>
              <div className="separator" />
              <div className="control-item properties-toggle">
                <label htmlFor="show-properties-toggle" className="control-label">Hiển thị tính chất</label>
                <label className="toggle-switch">
                    <input id="show-properties-toggle" type="checkbox" checked={showProperties} onChange={e => setShowProperties(e.target.checked)} />
                    <span className="slider"></span>
                </label>
              </div>
               <div className="control-item">
                <label htmlFor="show-relationships-toggle" className="control-label">Hiển thị hành vi</label>
                <label className="toggle-switch">
                    <input id="show-relationships-toggle" type="checkbox" checked={showRelationships} onChange={e => setShowRelationships(e.target.checked)} />
                    <span className="slider"></span>
                </label>
              </div>
              <div className="separator" />
              <button onClick={toggleFullscreen} className="control-button" title="Toggle fullscreen">
                ⛶
              </button>
            </div>
          </>
        )}
        {isLoading && <div className="loading-spinner" aria-label="Đang tải"></div>}
        {error && <p className="error-message">{error}</p>}
        {!isLoading && !error && !diagramData && (
          <div className="placeholder-container">
              <p className="placeholder">Sơ đồ của bạn sẽ xuất hiện ở đây.</p>
              <button onClick={handleImportClick} className="import-button">
                  Nhập sơ đồ từ file JSON
              </button>
          </div>
        )}
        {diagramToRender && diagramData && <Diagram key={diagramKey} ref={diagramRef} data={diagramToRender} keywordNumbers={diagramData.keywordNumbers} onDataChange={handleDataChange} showProperties={showProperties} showRelationships={showRelationships} highlightedIds={highlightedIds} initialLayout={initialLayout} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery}/>}
      </div>
      
      {isMermaidModalOpen && <MermaidModal code={mermaidCode} onClose={() => setIsMermaidModalOpen(false)} />}
    </main>
  );
}

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);