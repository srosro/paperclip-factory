import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { messagingApi } from "@/api/messaging";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";

interface LinearRequiredGateProps {
  children: React.ReactNode;
}

export function LinearRequiredGate({ children }: LinearRequiredGateProps) {
  const { selectedCompanyId } = useCompany();

  const statusQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.messaging.status(selectedCompanyId)
      : (["messaging", "status", "__disabled__"] as const),
    queryFn: () => messagingApi.getStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId || statusQuery.isLoading || statusQuery.isError) return <>{children}</>;

  const readiness = statusQuery.data?.readiness ?? "disabled";

  if (readiness === "ready") return <>{children}</>;

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Link2 className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect a Linear workspace to use issues</p>
        <p className="text-xs text-muted-foreground">
          Paperclip uses Linear as the ticketing backend. All issues are created and
          tracked there.
        </p>
      </div>
      <Button size="sm" asChild>
        <a href="/company/settings/messaging">Go to Messaging Settings</a>
      </Button>
    </div>
  );
}
