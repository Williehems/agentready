import { AuditConsole } from "@/components/AuditConsole";
import { ShellHeader } from "@/components/ShellHeader";

export const metadata = {
  title: "AgentReady: run an audit",
};

export default function AuditPage() {
  return (
    <main className="audit-texture relative flex min-h-screen flex-col">
      <ShellHeader crumb={{ href: "/runs", label: "runs" }} />

      <AuditConsole />
    </main>
  );
}
