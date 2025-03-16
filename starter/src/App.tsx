import { useEffect } from "react";
import "./styles/globals.css";
import { ThemeToggle } from "./components/ui/theme-toggle";
import { Button } from "./components/ui/button";

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

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-semibold">Flary Starter</h2>
            <nav className="flex gap-4">
              <a
                href="#"
                className="text-muted-foreground hover:text-foreground"
              >
                Docs
              </a>
              <a
                href="#"
                className="text-muted-foreground hover:text-foreground"
              >
                Components
              </a>
            </nav>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="container px-4 py-10">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            Welcome to Flary
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            A modern stack with Hono, Vite, Tailwind CSS, and shadcn/ui
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Button>Get Started</Button>
            <Button variant="outline">
              <a
                href="https://github.com/your-repo"
                target="_blank"
                rel="noopener noreferrer"
              >
                View on GitHub
              </a>
            </Button>
          </div>
        </div>

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              title: "Hono",
              description: "Ultrafast web framework for the Edges",
            },
            {
              title: "Vite",
              description: "Next Generation Frontend Tooling",
            },
            {
              title: "Tailwind CSS",
              description: "A utility-first CSS framework",
            },
            {
              title: "shadcn/ui",
              description: "Beautifully designed components",
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border bg-card p-6 text-card-foreground"
            >
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

export default App;
