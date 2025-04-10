import { RouterProvider, createBrowserRouter } from "react-router-dom";
import "./styles/globals.css";
import HomePage from "./pages/HomePage";
import DocsPage from "./pages/DocsPage";
import DashboardPage from "./pages/DashboardPage";
import PromptsPage from "./pages/PromptsPage";
import Layout from "./Layout";
import AppLayout from "./layouts/AppLayout";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./hooks/use-theme";
import PromptEditor from "./pages/PromptEditor";

// Create router with routes
const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "docs",
        element: <DocsPage />,
      },
    ],
  },
  // App pages with shared layout (sidebar, header, etc)
  {
    element: <AppLayout />,
    children: [
      {
        path: "/dashboard",
        element: <DashboardPage />,
      },
      {
        path: "/prompts",
        element: <PromptsPage />,
      },
      {
        path: "/prompts/editor/:promptId",
        element: <PromptEditor />,
      },
      {
        path: "/prompts/new",
        element: <PromptEditor />,
      },
    ],
  },
]);

function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
      <Toaster position="top-right" richColors closeButton />
    </ThemeProvider>
  );
}

export default App;
