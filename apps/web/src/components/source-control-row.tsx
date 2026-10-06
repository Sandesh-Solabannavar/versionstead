import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button, Collapsible, CollapsibleTrigger, CollapsibleContent, Badge } from "../ui";

export function SourceControlRow({
  name,
  icon,
  status,
  version,
  badge,
  description,
  control,
  children,
}: {
  name: string;
  icon: ReactNode;
  status: "available" | "attention" | "inactive";
  version?: string | null;
  badge?: string | null;
  description: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="source-control-row">
      <div className="source-control-summary">
        <div className="setting-description">
          <h3>
            <span className="source-control-mark" data-status={status} aria-hidden>
              {icon}
              <span className="source-control-dot" />
            </span>
            {name}
            {version && <code className="setting-version">{version}</code>}
            {badge && (
              <Badge
                tone={status === "attention" || badge === "Coming soon" ? "warning" : "neutral"}
              >
                {badge}
              </Badge>
            )}
          </h3>
          <p>{description}</p>
        </div>
        {(children || control) && (
          <div className="source-control-controls">
            {children && (
              <CollapsibleTrigger
                render={<Button variant="ghost" size="icon" />}
                aria-label={`Toggle ${name} details`}
              >
                <ChevronDown size={14} aria-hidden />
              </CollapsibleTrigger>
            )}
            {control}
          </div>
        )}
      </div>
      {children && (
        <CollapsibleContent>
          <div className="source-control-details">{children}</div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
