// Adapted from T3 Code (MIT); see public/THIRD_PARTY_NOTICES.txt.
import { useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

import { redactedPlaceholder } from "../redacted-text";

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const value = props.value?.trim();
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);

  if (!value) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer rounded-sm font-mono text-2xs leading-normal transition hover:text-foreground",
              revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-xs",
              props.className,
            )}
            onClick={() => setRevealed((current) => !current)}
            aria-label={props.ariaLabel}
            aria-pressed={revealed}
            data-redacted={!revealed}
          >
            {revealed ? value : redacted}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}
