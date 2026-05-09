import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Ticket-ref + justification inputs that admin dialogs across the platform
// (users, access, cases, compliance, finance, settings, ...) all require for
// audit-chain entries. Previously this exact two-field block was redefined
// inline in 6 routes — drift between them meant placeholders, row counts,
// and validation rules slowly diverged. One component, one source of truth.
export function ReasonFields({
  ticketRef,
  justification,
  onTicketRefChange,
  onJustificationChange,
  ticketPlaceholder,
  justificationPlaceholder,
}: {
  ticketRef: string;
  justification: string;
  onTicketRefChange: (value: string) => void;
  onJustificationChange: (value: string) => void;
  ticketPlaceholder?: string;
  justificationPlaceholder?: string;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label>Ticket reference</Label>
        <Input
          value={ticketRef}
          onChange={(event) => onTicketRefChange(event.target.value)}
          placeholder={ticketPlaceholder ?? "Ticket reference (INC-, ACCESS-, FIN-, etc.)"}
        />
      </div>
      <div className="space-y-2">
        <Label>Justification</Label>
        <Textarea
          value={justification}
          rows={4}
          onChange={(event) => onJustificationChange(event.target.value)}
          placeholder={justificationPlaceholder ?? "Purpose, scope, and approval rationale."}
        />
      </div>
    </>
  );
}
