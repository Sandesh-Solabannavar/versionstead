import type { ReactNode } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";

export function SettingRow({
  label,
  description,
  children,
  mark,
  version,
}: {
  label: string;
  description: string;
  children: ReactNode;
  mark?: ReactNode;
  version?: string | null;
}) {
  return (
    <div className="preference-row">
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
