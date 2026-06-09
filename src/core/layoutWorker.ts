/// <reference lib="webworker" />
import type { Edge, Node } from "@xyflow/react";
import { archLayout, type ArchLayout } from "./layout";

/** Off-main-thread architecture layout. archLayout is a multi-second
 *  synchronous multi-start search (it routes the graph ~STARTS times to pick
 *  the best); running it here keeps the UI responsive and the spinner animating
 *  instead of freezing the main thread. The caller cancels a stale run by
 *  terminating the worker. */
interface Req {
  nodes: Node[];
  edges: Edge[];
  labelRoom: boolean;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { nodes, edges, labelRoom } = e.data;
  const result: ArchLayout = archLayout(nodes, edges, labelRoom);
  (self as unknown as Worker).postMessage(result);
};
