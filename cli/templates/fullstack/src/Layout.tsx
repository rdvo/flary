import { Link, Outlet, useLocation } from "react-router-dom";
import { ThemeToggle } from "./components/ui/theme-toggle";
import { useTheme } from "@/hooks/use-theme";

export default function Layout() {
  // Initialize theme using the hook
  useTheme();
  const location = useLocation();

  // Only show header on homepage
  const isHomePage = location.pathname === "/";

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      {isHomePage && (
        <header className="border-b">
          <div className="flex h-16 items-center justify-between px-4 md:px-6 max-w-screen-2xl mx-auto">
            <div className="flex items-center gap-6">
              <Link to="/" className="text-lg font-semibold">
                RELAY
              </Link>
              <nav className="flex gap-4">
                <Link
                  to="/"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Home
                </Link>
                <Link
                  to="/docs"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Docs
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
            </div>
          </div>
        </header>
      )}

      <Outlet />
    </div>
  );
}
