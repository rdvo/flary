import { useEffect, useCallback, useState, useRef } from "react";
import "@xyflow/react/dist/base.css";
import "./styles/globals.css";
import { ThemeToggle } from "./components/ui/theme-toggle";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { PartySocket } from "partysocket";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Controls,
  MiniMap,
  Background,
  Edge,
  NodeChange,
  EdgeChange,
  Node,
} from "@xyflow/react";

// Define custom node type with version vector
type CustomNode = Node<{
  label: string;
}>;

// Define custom node change type
type CustomNodeChange = NodeChange<CustomNode>;

const initialNodes: CustomNode[] = [
  {
    id: "1",
    position: { x: 250, y: 100 },
    data: { label: "Node 1" },
    style: {
      width: 150,
      padding: 10,
      borderRadius: 8,
      border: "1px solid #000",
      backgroundColor: "white",
    },
  },
  {
    id: "2",
    position: { x: 250, y: 250 },
    data: { label: "Node 2" },
    style: {
      width: 150,
      padding: 10,
      borderRadius: 8,
      border: "1px solid #000",
      backgroundColor: "white",
    },
  },
];
const initialEdges: Edge[] = [];

// Define provider type
type YProviderType = InstanceType<typeof YProvider>;

// Custom connection status component that won't flicker during dragging
function ConnectionStatus({
  isConnected,
  connectedUsers,
}: {
  isConnected: boolean;
  connectedUsers: number;
}) {
  // Use a reference to track state changes without triggering re-renders
  const lastConnectedRef = useRef(isConnected);
  const [displayStatus, setDisplayStatus] = useState(isConnected);

  // Update display status only after a delay and only for disconnections
  useEffect(() => {
    // If reconnecting, update immediately
    if (isConnected && !lastConnectedRef.current) {
      setDisplayStatus(true);
      lastConnectedRef.current = true;
    }

    // If disconnecting, wait to ensure it's not just a brief blip
    if (!isConnected && lastConnectedRef.current) {
      const timer = setTimeout(() => {
        setDisplayStatus(false);
        lastConnectedRef.current = false;
      }, 2000); // 2 second grace period for reconnection

      return () => clearTimeout(timer);
    }
  }, [isConnected]);

  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full ${
          displayStatus ? "bg-green-500" : "bg-red-500"
        }`}
      />
      <span className="text-sm text-muted-foreground">
        {displayStatus ? "Connected" : "Disconnected"}
      </span>
      <span className="text-sm text-muted-foreground ml-4">
        {connectedUsers} {connectedUsers === 1 ? "user" : "users"} online
      </span>
    </div>
  );
}

function CanvasEditor({ canvasId }: { canvasId: string }) {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<CustomNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [connectedUsers, setConnectedUsers] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<YProviderType | null>(null);
  const socketRef = useRef<PartySocket | null>(null);

  // Initialize Yjs document and sync
  useEffect(() => {
    try {
      // Create Yjs document
      const ydoc = new Y.Doc();
      ydocRef.current = ydoc;

      // Get shared data structures
      const yNodes = ydoc.getMap("nodes");
      const yEdges = ydoc.getMap("edges");

      // Set initial data if needed
      if (yNodes.size === 0) {
        initialNodes.forEach((node) => {
          yNodes.set(node.id, node);
        });
      }

      // Connect to the provider
      const host = window.location.host;
      console.log("Host:", host);

      // Create provider first
      const provider = new YProvider(host, `canvas-${canvasId}`, ydoc, {
        connect: true,
        party: "canvas",
      });
      providerRef.current = provider;

      // Create PartySocket instance
      const socket = new PartySocket({
        host: host,
        room: `canvas-${canvasId}`,
        party: "canvas",
      });
      socketRef.current = socket;

      // Listen for node changes, but buffer them during dragging
      const nodeObserver = () => {
        if (isDragging) return; // Skip updates during dragging

        const updatedNodes = Array.from(yNodes.values()) as CustomNode[];
        if (updatedNodes.length > 0) {
          console.log("Received node updates from peers");
          setNodes(updatedNodes);
        }
      };

      yNodes.observe(nodeObserver);

      // Listen for edge changes
      yEdges.observe(() => {
        const updatedEdges = Array.from(yEdges.values()) as Edge[];
        if (updatedEdges.length > 0) {
          setEdges(updatedEdges);
        }
      });

      // Connection status management - industry standard approach
      // This prevents UI flicker during operations
      let connectionTimeout: NodeJS.Timeout | null = null;

      const setStableConnectionStatus = (status: boolean) => {
        // Clear any pending status changes
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        setIsConnected(status);
      };

      // Socket connection handlers
      socket.addEventListener("open", () => {
        console.log("WebSocket connected");
        setStableConnectionStatus(true);
      });

      socket.addEventListener("close", () => {
        console.log("WebSocket disconnected");
        // Use timeout to prevent quick flashes on reconnection attempts
        connectionTimeout = setTimeout(() => {
          setStableConnectionStatus(false);
        }, 2000);
      });

      socket.addEventListener("error", (event: Event) => {
        console.error("WebSocket error:", event);
      });

      // Update connected users from awareness protocol
      provider.awareness.on("change", () => {
        const states = Array.from(provider.awareness.getStates().values());
        // Only count client states for user count
        const clientStates = states.filter((state) => state.type === "client");
        const count = clientStates.length;

        console.log(
          "Connected Users:",
          clientStates.map((state) => ({
            name: state.user?.name || "Unknown",
            color: state.user?.color || "#000000",
            joinedAt: state.user?.joinedAt
              ? new Date(state.user.joinedAt).toLocaleTimeString()
              : "Unknown",
            type: state.type,
          }))
        );
        setConnectedUsers(count);
      });

      // Set local user state with more info
      const localUser = {
        user: {
          name: `User-${Math.floor(Math.random() * 10000)}`,
          color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
          joinedAt: Date.now(),
        },
        type: "client",
      };
      console.log("Setting local user state:", localUser);
      provider.awareness.setLocalState(localUser);

      return () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        socket.close();
        provider.disconnect();
        ydoc.destroy();
      };
    } catch (error) {
      console.error("Error initializing Yjs:", error);
    }
  }, [canvasId, setNodes, setEdges]);

  // Create a separate effect to handle node updates during drag state changes
  useEffect(() => {
    if (!ydocRef.current) return;

    const yNodes = ydocRef.current.getMap("nodes");

    // When not dragging, make sure we have the latest nodes
    if (!isDragging) {
      const updatedNodes = Array.from(yNodes.values()) as CustomNode[];
      if (updatedNodes.length > 0) {
        setNodes(updatedNodes);
      }
    }
  }, [isDragging, setNodes]);

  // Drag handlers
  const onNodeDragStart = useCallback(() => {
    console.log("Drag started");
    // Just setting the drag state locally without affecting connections
    setIsDragging(true);
  }, []);

  const onNodeDragStop = useCallback(() => {
    console.log("Drag stopped");

    // Don't touch connection status during node sync
    // Just sync the nodes without affecting connection display
    if (ydocRef.current && providerRef.current) {
      const doc = ydocRef.current;
      const yNodes = doc.getMap("nodes");

      // Use requestAnimationFrame to avoid any interference with UI rendering
      requestAnimationFrame(() => {
        try {
          // Best practice: Use a transaction for batching all updates
          doc.transact(() => {
            // Sync each node position
            nodes.forEach((node) => {
              yNodes.set(node.id, node);
            });
          });
          console.log("All nodes synced after drag");
        } catch (err) {
          console.error("Error syncing nodes:", err);
        } finally {
          // Set dragging to false after syncing
          setIsDragging(false);
        }
      });
    } else {
      setIsDragging(false);
    }
  }, [nodes]);

  // Node changes handler - only used for local changes
  const handleNodesChange = useCallback(
    (changes: CustomNodeChange[]) => {
      // Apply changes locally first
      onNodesChange(changes);

      // Don't sync during dragging - we'll do that on drag stop
      if (isDragging) return;

      // Only sync if we have yjs set up and it's a position change
      if (!ydocRef.current) return;

      // Only sync non-dragging position changes
      const positionChanges = changes.filter(
        (
          change
        ): change is CustomNodeChange & { id: string; type: "position" } =>
          change.type === "position" &&
          !("dragging" in change && change.dragging)
      );

      if (positionChanges.length > 0) {
        const doc = ydocRef.current;
        const yNodes = doc.getMap("nodes");

        doc.transact(() => {
          positionChanges.forEach((change) => {
            const node = nodes.find((n) => n.id === change.id);
            if (node) {
              console.log("Syncing node position change:", node.id);
              yNodes.set(node.id, node);
            }
          });
        });
      }
    },
    [nodes, isDragging, onNodesChange]
  );

  // Edge changes handler
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Apply changes locally
      onEdgesChange(changes);

      // Sync to Yjs
      if (!ydocRef.current) return;

      try {
        const doc = ydocRef.current;
        const yEdges = doc.getMap("edges");

        doc.transact(() => {
          // Update edges in the shared map
          edges.forEach((edge) => {
            yEdges.set(edge.id, edge);
          });
        });
      } catch (error) {
        console.error("Error syncing edges:", error);
      }
    },
    [edges, onEdgesChange]
  );

  // Connection handler
  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => {
        const newEdges = addEdge({ ...params, id: `e${Date.now()}` }, eds);

        // Sync to Yjs
        if (ydocRef.current) {
          try {
            const doc = ydocRef.current;
            const yEdges = doc.getMap("edges");

            doc.transact(() => {
              newEdges.forEach((edge) => {
                yEdges.set(edge.id, edge);
              });
            });
          } catch (error) {
            console.error("Error syncing new edge:", error);
          }
        }

        return newEdges;
      });
    },
    [setEdges]
  );

  return (
    <>
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-semibold">Canvas: {canvasId}</h2>

            <ConnectionStatus
              isConnected={isConnected}
              connectedUsers={connectedUsers}
            />

            <p className="text-sm text-muted-foreground">
              Try connecting the nodes by dragging between them! Changes are
              synced in real-time.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div style={{ width: "100%", height: "calc(100vh - 64px)" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          fitView
          defaultViewport={{ x: 0, y: 0, zoom: 1.5 }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </>
  );
}

function LandingPage() {
  const createNewCanvas = () => {
    const id = Math.random().toString(36).substring(2, 9);
    window.location.href = `/canvas/${id}`;
  };

  return (
    <>
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-semibold">Multiplayer Canvas</h2>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            Collaborative Flow Editor
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            Create and share interactive flow diagrams in real-time.
          </p>
          <div className="mt-10">
            <button
              onClick={createNewCanvas}
              className="rounded-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              Create New Canvas
            </button>
          </div>
        </div>
      </main>
    </>
  );
}

function App() {
  // Initialize theme on mount
  useEffect(() => {
    // Check for saved theme preference or use dark as default
    const savedTheme = localStorage.getItem("theme");

    if (savedTheme === "light") {
      document.documentElement.classList.remove("dark");
    } else {
      // Default to dark mode
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    }
  }, []);

  // Get canvas ID from URL path (/canvas/<id>)
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const isCanvasRoute = pathParts[0] === "canvas";
  const canvasId = pathParts[1];

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      {isCanvasRoute && canvasId ? (
        <CanvasEditor canvasId={canvasId} />
      ) : (
        <LandingPage />
      )}
    </div>
  );
}

export default App;
