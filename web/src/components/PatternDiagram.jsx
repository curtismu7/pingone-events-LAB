import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import DiagramStepBar from "./DiagramStepBar";
import { useDiagramStepper } from "../hooks/useDiagramStepper";
import { REFIT_EVENT, useFitOnResize } from "../hooks/useFitOnResize";
import { ArrowNoLabel, EdgeLabels, FitOpen, Passport, PassportActions } from "../diagram-kit/DiagramKit.jsx";
import { boxPassport, sidePoint } from "../diagram-kit/diagramKit.js";
import "../diagram-kit/diagram-kit.css";
import "./PatternDiagram.css";

// minZoom keeps labels readable on a narrow screen: the diagram is then wider than the canvas and is panned, not shrunk to dots.
const FIT = { padding: 0.1, minZoom: 0.6 };
const narrowNow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
const HANDLES = [["t", Position.Top], ["b", Position.Bottom], ["l", Position.Left], ["r", Position.Right]];

function Box({ data }) {
  return (
    <div className={`pat-node pat-node--${data.kind}${data.on ? " pat-node--on" : ""}${data.passport ? " dk-open" : ""}`} data-testid={`pat-node-${data.id}`}>
      {HANDLES.map(([k, pos]) => (
        <span key={k}>
          <Handle id={`s-${k}`} type="source" position={pos} className="pat-handle" />
          <Handle id={`t-${k}`} type="target" position={pos} className="pat-handle" />
        </span>
      ))}
      {data.label}
      {data.passport && <Passport p={data.passport} />}
    </div>
  );
}
const nodeTypes = { box: Box };

// The arrow draws the curve only: every label is drawn by EdgeLabels, above the boxes, placed clear of the other labels and the boxes.
const edgeTypes = { arrow: ArrowNoLabel };

// Pick the sides of the two boxes that face each other, so an arrow leaves toward its target.
function sides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ["r", "l"] : ["l", "r"]) : (dy > 0 ? ["b", "t"] : ["t", "b"]);
}

function Canvas({ pattern, graph, positions, onMove, stepper, open, setOpen }) {
  const ref = useRef(null);
  useFitOnResize(ref, FIT);
  const active = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(max-width: 600px)"); const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on); return () => mq.removeEventListener?.("change", on);
  }, []);
  const nodes = pattern.nodes.map((n) => ({
    id: n.id, type: "box", position: positions[n.id], draggable: true, zIndex: n.id === open ? 10 : undefined, // an expanded box sits above its neighbours
    data: { id: n.id, label: n.label, kind: n.kind, on: !!active && (active.from === n.id || active.to === n.id), passport: n.id === open ? boxPassport(graph, n.id) : null },
  }));
  const edges = pattern.steps.map((s, i) => {
    let [a, b] = sides(positions[s.from], positions[s.to]);
    // A reply along the same pair of boxes leaves from the side instead, so the two arrows and labels do not overlap.
    if (pattern.steps.slice(0, i).some((o) => o.from === s.to && o.to === s.from)) [a, b] = a === "l" || a === "r" ? ["b", "b"] : ["r", "r"];
    const cp = s.to === "rule";
    const now = stepper.step === i;
    const seen = stepper.step >= 0 && i <= stepper.step;
    return {
      id: `e${i}`, source: s.from, target: s.to, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, type: "arrow",
      animated: now,
      className: `pat-edge${cp ? " pat-edge--cp" : ""}${now ? " pat-edge--now" : ""}${stepper.step >= 0 && !seen ? " pat-edge--dim" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
  // One label per arrow, in a layer above the boxes, placed clear of the other labels and the boxes. On a narrow screen the label is its number.
  const labels = pattern.steps.map((s, i) => ({
    id: `e${i}`, text: narrow ? `${i + 1}` : `${i + 1}. ${s.edge ?? s.label}`, source: s.from, target: s.to, sourceHandle: edges[i].sourceHandle, targetHandle: edges[i].targetHandle,
    active: stepper.step === i, dim: stepper.step >= 0 && !(i <= stepper.step),
  }));
  // What an expanded box can do: open the box at the far end of an arrow, close itself, and make a link that opens this page with the box expanded.
  const actions = useMemo(() => ({
    open: (id) => setOpen(id), close: () => setOpen(null),
    link: (id) => { const u = new URL(window.location.href); u.searchParams.set("box", id); return u.toString(); },
  }), [setOpen]);
  return (
    <div ref={ref} className="pat-canvas" data-testid="pattern-canvas">
      <PassportActions.Provider value={actions}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={FIT} nodesConnectable={false} minZoom={0.3}
          onNodeClick={(_, n) => setOpen((o) => (o === n.id ? null : n.id))} onPaneClick={() => setOpen(null)}
          onNodeDragStop={(_, n) => onMove(n.id, n.position)} onNodeDrag={(_, n) => onMove(n.id, n.position)} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={18} />
          <Controls showInteractive={false} />
          <EdgeLabels items={labels} pointFor={(box, handle) => sidePoint(box, String(handle).split("-")[1])} fallback={{ w: 150, h: 56 }} />
          <FitOpen open={open} closePadding={FIT.padding} />
        </ReactFlow>
      </PassportActions.Provider>
    </div>
  );
}

export default function PatternDiagram({ pattern, resetSignal = 0 }) {
  const initial = useMemo(() => Object.fromEntries(pattern.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), [pattern]);
  const [positions, setPositions] = useState(initial);
  const stepper = useDiagramStepper(pattern.steps.length);
  // The pattern as a graph (boxes and arrows) for the box details; a box's kind is its group.
  const graph = useMemo(() => ({ nodes: pattern.nodes.map((n) => ({ id: n.id, label: n.label, group: n.kind })), edges: pattern.steps.map((st, i) => ({ source: st.from, target: st.to, label: `${i + 1}. ${st.edge ?? st.label}` })) }), [pattern]);
  const [open, setOpen] = useState(() => { const box = new URLSearchParams(window.location.search).get("box"); return box && pattern.nodes.some((n) => n.id === box) ? box : null; }); // a shared link's box
  const onMove = useCallback((id, p) => setPositions((cur) => ({ ...cur, [id]: { x: p.x, y: p.y } })), []);
  const step = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  // Reset restores box positions as well as the walkthrough and the view. The page-level Reset raises resetSignal.
  const reset = useCallback(() => { stepper.stop(); setPositions(initial); setOpen(null); setTimeout(() => window.dispatchEvent(new Event(REFIT_EVENT)), 0); }, [stepper.stop, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef(resetSignal);
  useEffect(() => { if (seen.current !== resetSignal) { seen.current = resetSignal; reset(); } }, [resetSignal, reset]);
  return (
    <section className="pat" aria-label={pattern.title}>
      <h2 className="pat__title">{pattern.title}</h2>
      <p className="intro">{pattern.intro}</p>
      <DiagramStepBar stepper={stepper} caption={step ? step.label : ""} testId="pattern-step-bar" />
      <button type="button" className="pat-reset" onClick={reset} data-testid="pattern-reset">Reset positions and walkthrough</button>
      {step && (
        <article className="track__now" data-testid="pattern-now">
          <h3>Step {stepper.step + 1}: {step.label}</h3>
          <p>{step.say}</p>
        </article>
      )}
      <ReactFlowProvider>
        <Canvas pattern={pattern} graph={graph} positions={positions} onMove={onMove} stepper={stepper} open={open} setOpen={setOpen} />
      </ReactFlowProvider>
      <p className="keys">Drag any box. Mock-issued token values; hosts are examples. Moved: {Object.keys(positions).filter((k) => positions[k].x !== initial[k].x || positions[k].y !== initial[k].y).length} box(es).</p>
    </section>
  );
}
