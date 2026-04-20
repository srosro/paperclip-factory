import { useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

export function SettingsMessaging() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Messaging" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Messaging</h1>
      </div>

      <div
        className="space-y-3 rounded-md border border-border px-4 py-4"
        data-testid="messaging-coming-soon"
      >
        <p className="text-sm text-muted-foreground">
          Messaging is currently disabled for this company. Linear integration
          is being added in the next phase of the migration.
        </p>
        <Button size="sm" disabled data-testid="messaging-connect-linear">
          Connect Linear workspace (coming soon)
        </Button>
      </div>
    </div>
  );
}
