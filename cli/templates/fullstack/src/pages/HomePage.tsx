import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";

export default function HomePage() {
  const features = [
    {
      title: "Dashboard",
      description: "Comprehensive analytics and reporting",
    },
    {
      title: "Real-time Data",
      description: "Live updates and monitoring",
    },
    {
      title: "User Management",
      description: "Control access and permissions",
    },
    {
      title: "Analytics",
      description: "Insights and data visualization",
    },
  ];

  return (
    <main className="container py-10">
      <section className="mb-16">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            Welcome to RELAY
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground max-w-2xl mx-auto">
            The next generation analytics and reporting platform for modern
            businesses
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Button asChild>
              <Link to="/dashboard">Go to Dashboard</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/docs">View Documentation</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mb-16 max-w-4xl mx-auto">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border bg-card p-6 text-card-foreground hover:shadow-md transition-shadow"
            >
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="py-8 px-6 bg-muted/50 rounded-xl max-w-4xl mx-auto">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Get Started Today</h2>
          <p className="text-muted-foreground mb-6 max-w-lg mx-auto">
            Experience the power of RELAY's analytics dashboard. Navigate to the
            dashboard to explore all features.
          </p>
          <Button asChild size="lg">
            <Link to="/dashboard">Launch Dashboard</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
