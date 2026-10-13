import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const services = [
  { key: "database", label: "CRM storage", help: "Start MySQL to create workspaces and save records." },
  { key: "llm", label: "Command understanding", help: "Start Ollama with the configured model. Forms and templates work without AI." },
  { key: "stt", label: "Speech recognition", help: "Start whisper_server.py to transcribe recordings. You can still type commands." },
  { key: "tts", label: "Spoken responses", help: "Start tts_server.py for audio responses. Written receipts remain available." },
];

const steps = [
  "Choose the Sales template below, review its fields, and create a local workspace.",
  "Choose Companies, then enter a fictional company using the form or say \"Create a company named Nova Labs.\"",
  "Review the proposed values and confirm. Select the saved record before asking for an update.",
  "Use Training to review command examples and corrected recordings. Connect an external CRM later from Connections.",
];

export default function StudioGettingStarted() {
  const status = trpc.studio.readiness.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  return <div className="studio-card studio-stack">
    <div className="studio-row">
      <h3>Workspace health</h3>
      <Button variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>
        {status.isFetching ? "Checking services…" : "Check services"}
      </Button>
    </div>
    <p>Start here without Salesforce, HubSpot or Twenty credentials. Records are saved in your local database.</p>
    {status.error && <p role="alert">Could not check services. {status.error.message}</p>}
    <div className="service-status-grid" aria-live="polite">
      {services.map(service => (
        <div key={service.key} className="service-status-card">
          <strong>{service.label}</strong>
          <p className={status.data ? (status.data.services[service.key] ? "service-ready" : "service-unavailable") : undefined}>
            {status.data ? (status.data.services[service.key] ? "Ready" : "Unavailable") : "Not checked"}
          </p>
          {status.data && !status.data.services[service.key] && <small>{service.help}</small>}
        </div>
      ))}
    </div>
    <ol className="getting-started-steps">
      {steps.map((text, index) => (
        <li key={index}>
          <div className="getting-started-step">
            <span className="step-number">{index + 1}</span>
            <span>{text}</span>
          </div>
        </li>
      ))}
    </ol>
  </div>;
}
