import { AlertTriangle, RefreshCcw } from "lucide-react";

export type BrokerReadinessState = "checking" | "starting" | "ready" | "error";

export interface BrokerReadiness {
  state: BrokerReadinessState;
  message: string;
  detail?: string | null;
}

export const brokerReadinessLabels: Record<BrokerReadinessState, string> = {
  checking: "broker checking",
  starting: "broker starting",
  ready: "broker live",
  error: "broker offline",
};

interface BrokerReadinessPanelProps {
  readiness: BrokerReadiness;
  onRetry: () => void;
}

export function BrokerReadinessPanel({ readiness, onRetry }: BrokerReadinessPanelProps) {
  const isError = readiness.state === "error";
  return (
    <div className={`broker-readiness-panel state-${readiness.state}`} role="status">
      <span className="broker-readiness-mark" aria-hidden="true">
        {isError ? <AlertTriangle size={16} /> : <RefreshCcw size={16} />}
      </span>
      <div>
        <strong>{readiness.message}</strong>
        {readiness.detail ? <span>{readiness.detail}</span> : null}
      </div>
      <button type="button" className="broker-retry-button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
