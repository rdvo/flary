import { Outlet } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background">
        <div className="flex h-screen flex-col">
          <SiteHeader />
          <main className="flex-1 overflow-auto">
            <div className="@container/main flex flex-1 flex-col gap-2">
              <div className="flex flex-col gap-4 pt-0 pb-4 md:gap-6 md:pt-2 md:pb-6">
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
