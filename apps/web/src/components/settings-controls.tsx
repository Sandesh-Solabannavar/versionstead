import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { settingTargetId } from "../settings-navigation";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";

const SearchTarget = createContext<string | null>(null);
export function SettingsSearchTargets({ children }: { children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  return <SearchTarget value={hash.replace(/^#/, "")}>{children}</SearchTarget>;
}

export function SettingRow({
  label,
  description,
  children,
  mark,
  version,
  searchable = true,
}: {
  label: string;
  description: ReactNode;
  children: ReactNode;
  mark?: ReactNode;
  version?: string | null;
  searchable?: boolean;
}) {
  const target = useContext(SearchTarget);
  const id = searchable && target !== null ? settingTargetId(label) : undefined;
  const focusTarget = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && target && id === target) {
        element.scrollIntoView({ block: "center" });
        element.focus({ preventScroll: true });
      }
    },
    [id, target],
  );
  return (
    <div className="preference-row" id={id} tabIndex={id ? -1 : undefined} ref={focusTarget}>
      <div className="setting-description">
        <h3>
          {mark}
          {label}
          {version && <code className="setting-version">{version}</code>}
        </h3>
        <p>{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
export function SettingGroup({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="setting-section">
      <div className="section-title-row">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="setting-group">{children}</div>
    </section>
  );
}
export function Choice({
  label,
  value,
  items,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem value={item.value} key={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
