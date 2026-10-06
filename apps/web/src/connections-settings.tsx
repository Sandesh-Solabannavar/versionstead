import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Autocomplete } from "@base-ui/react/autocomplete";
import {
  ArrowLeft,
  ChevronsLeftRightEllipsis,
  Copy,
  Ellipsis,
  Monitor,
  Plus,
  Terminal,
} from "lucide-react";
import {
  decodeInvitation,
  decodeSshHostList,
  parsePairingInvitation,
  remotePairingFields,
  type SshTarget,
  type ConnectedComputer,
} from "@versionstead/contracts/application";
import { decodeMonitoringSettings } from "@versionstead/contracts/monitoring";
import { useApplication } from "./application";
import { request, useMonitoring } from "./monitoring";
import { SettingGroup, SettingRow, Choice } from "./components/settings-controls";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./components/ui/menu";
import { Switch } from "./components/ui/switch";
import { RefreshIcon } from "./components/ui/refresh-icon";
import { Button, Dialog, Input, timestamp } from "./ui";

function ConnectionModeCard({
  selected,
  title,
  description,
  icon,
  disabled,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`connection-mode-card ${selected ? "selected" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="connection-mode-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </button>
  );
}

function sshFields(host: string, username: string, port: string): SshTarget {
  const parsed =
    /^(?:([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@)?([a-zA-Z0-9][a-zA-Z0-9._-]{0,252})(?::(\d+))?$/.exec(
      host.trim(),
    );
  const user = username.trim() || parsed?.[1];
  const number = Number(port.trim() || parsed?.[3] || "22");
  if (
    !parsed ||
    (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(user)) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 65535
  )
    throw new Error("Enter a valid SSH host, username, and port from 1 to 65535.");
  return {
    host: parsed[2]!,
    ...(user ? { username: user } : {}),
    ...(port.trim() || parsed[3] ? { port: number } : {}),
  };
}

export function AddEnvironmentDialog({ close }: { close: () => void }) {
  const { connectComputer } = useApplication();
  const { connection } = useMonitoring();
  const [mode, setMode] = useState<"remote" | "ssh">("remote");
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [target, setTarget] = useState<SshTarget | null>(null);
  const [discovery, setDiscovery] = useState<ReturnType<typeof decodeSshHostList> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const autocompleteContainer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode !== "ssh") return;
    const controller = new AbortController();
    void request("/api/application/ssh-hosts", decodeSshHostList, {
      signal: controller.signal,
    }).then(setDiscovery, (failure) => {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "SSH hosts could not be loaded.");
    });
    return () => controller.abort();
  }, [mode]);
  const changeHost = (value: string) => {
    setError(null);
    try {
      const parsed = parsePairingInvitation(value);
      setHost(parsed.host);
      setCode(parsed.pairingCode);
    } catch {
      setHost(value);
    }
  };
  const submit = async () => {
    setError(null);
    try {
      if (mode === "ssh" && !target) {
        setTarget(sshFields(sshHost, username, port));
        return;
      }
      const invitation = remotePairingFields(host, code);
      setPending(true);
      await connectComputer(invitation, mode === "ssh" ? (target ?? undefined) : undefined);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The environment could not connect.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="Add Environment"
      description="Pair another environment to this client."
      className="environment-dialog"
      dismissible={!pending}
      onClose={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-busy={pending}
      >
        <div className="connection-mode-grid">
          <ConnectionModeCard
            selected={mode === "remote"}
            title="Remote link"
            description="Enter a backend host and pairing code."
            icon={<ChevronsLeftRightEllipsis size={16} aria-hidden />}
            disabled={pending}
            onClick={() => {
              setMode("remote");
              setError(null);
            }}
          />
          <ConnectionModeCard
            selected={mode === "ssh"}
            title="SSH"
            description="Use local SSH config, agent, and tunnels for the backend."
            icon={<Terminal size={16} aria-hidden />}
            disabled={pending}
            onClick={() => {
              setMode("ssh");
              setError(null);
            }}
          />
        </div>
        {mode === "ssh" && !target ? (
          <div className="connection-fields">
            <div ref={autocompleteContainer}>
              <label htmlFor="environment-ssh-host" className="field-label">
                SSH host or alias
              </label>
              <Autocomplete.Root
                items={discovery?.hosts ?? []}
                itemToStringValue={(item) => item.host}
                value={sshHost}
                openOnInputClick
                onValueChange={(value, details) => {
                  setSshHost(value);
                  if (details.reason === "item-press") {
                    const selected = discovery?.hosts.find((item) => item.host === value);
                    if (selected) {
                      setUsername(selected.username ?? "");
                      setPort(selected.port ? String(selected.port) : "");
                    }
                  }
                }}
              >
                <Autocomplete.Input
                  id="environment-ssh-host"
                  render={<Input />}
                  placeholder="Search hosts or type devbox"
                  disabled={pending}
                  spellCheck={false}
                />
                <Autocomplete.Portal container={autocompleteContainer}>
                  <Autocomplete.Positioner sideOffset={4} className="z-[130]">
                    <Autocomplete.Popup className="ssh-host-suggestions">
                      <Autocomplete.Empty>
                        No matching saved hosts. You can type a hostname.
                      </Autocomplete.Empty>
                      <Autocomplete.List>
                        {(item: SshTarget) => (
                          <Autocomplete.Item
                            key={item.host}
                            value={item}
                            className="connection-menu-item"
                          >
                            <strong>{item.host}</strong>
                            <span className="muted">
                              {item.username ? `${item.username}@` : ""}
                              {item.host}
                              {item.port ? `:${item.port}` : ""}
                            </span>
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.List>
                    </Autocomplete.Popup>
                  </Autocomplete.Positioner>
                </Autocomplete.Portal>
              </Autocomplete.Root>
            </div>
            <div className="connection-input-grid ssh">
              <label className="field-label">
                Username
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                />
              </label>
              <label className="field-label">
                Port
                <Input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  inputMode="numeric"
                  maxLength={5}
                  disabled={pending}
                />
              </label>
            </div>
            {discovery?.error && (
              <p className="muted small" role="status">
                {discovery.error}
              </p>
            )}
          </div>
        ) : (
          <div className="connection-fields">
            {mode === "ssh" && target && (
              <div className="connection-ssh-summary">
                <Button variant="ghost" disabled={pending} onClick={() => setTarget(null)}>
                  <ArrowLeft size={14} aria-hidden /> SSH details
                </Button>
                <span className="muted small">
                  {target.host} · Verify the running monitor with its pairing link.
                </span>
              </div>
            )}
            <div className="connection-input-grid remote">
              <label className="field-label">
                Host
                <Input
                  value={host}
                  onChange={(e) => changeHost(e.target.value)}
                  placeholder="100.100.10.20:4389"
                  autoComplete="off"
                  maxLength={4096}
                  spellCheck={false}
                  disabled={pending}
                />
              </label>
              <label className="field-label">
                Pairing code
                <Input
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setError(null);
                  }}
                  placeholder="PAIRCODE"
                  type="password"
                  autoComplete="off"
                  maxLength={2048}
                  spellCheck={false}
                  disabled={pending}
                />
              </label>
            </div>
            <p className="muted small">
              Paste a full pairing URL into Host to fill both fields automatically.
            </p>
          </div>
        )}
        {error && (
          <p className="connection-form-error" role="alert">
            {error}
          </p>
        )}
        <Button
          className="connection-submit"
          type="submit"
          disabled={
            pending ||
            connection !== "connected" ||
            (mode === "ssh" && discovery?.available === false)
          }
        >
          {pending ? (
            <RefreshIcon size="sm" refreshing aria-hidden />
          ) : (
            <Plus size={14} aria-hidden />
          )}
          {pending ? "Adding…" : "Add environment"}
        </Button>
      </form>
    </Dialog>
  );
}

function SavedEnvironment({
  computer,
  disabled,
}: {
  computer: ConnectedComputer;
  disabled: boolean;
}) {
  const { change } = useApplication();
  const enabled = computer.enabled !== false;
  const status = !enabled
    ? "Disabled"
    : computer.error
      ? "Disconnected"
      : computer.snapshot
        ? "Connected"
        : "Connecting…";
  const [removing, setRemoving] = useState(false);
  return (
    <div className="saved-environment">
      <div className="saved-environment-main">
        <div className="environment-icon">
          <Monitor size={17} aria-hidden />
          <span
            className={`environment-status ${!enabled ? "disabled" : computer.error ? "warning" : "connected"}`}
          />
        </div>
        <div className="saved-environment-description">
          <Link to="/computers/$computerId" params={{ computerId: computer.id }}>
            {computer.label}
          </Link>
          <p>
            {computer.ssh ? `SSH · ${computer.ssh.host}` : computer.origin} · {status}
          </p>
        </div>
        <Switch
          aria-label={`Enable ${computer.label}`}
          checked={enabled}
          disabled={disabled || removing}
          onCheckedChange={(value) => {
            void change(
              "computers/enabled",
              { id: computer.id, enabled: value },
              value ? "Environment enabled." : "Environment disabled. Saved evidence is retained.",
              "PATCH",
            );
          }}
        />
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                className="utility-button"
                aria-label={`More actions for ${computer.label}`}
              />
            }
          >
            <Ellipsis size={15} aria-hidden />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem
              disabled={disabled || !enabled}
              onClick={() => {
                void change(
                  "computers/refresh",
                  { id: computer.id },
                  "Environment evidence refreshed.",
                );
              }}
            >
              Refresh evidence
            </MenuItem>
            <MenuItem
              disabled={disabled || !enabled}
              onClick={() => {
                void change("computers/scan", { id: computer.id }, "Read-only scan requested.");
              }}
            >
              Scan selected sources
            </MenuItem>
            <MenuItem
              disabled={disabled || removing}
              className="error-text"
              onClick={() => setRemoving(true)}
            >
              Remove environment
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {enabled && computer.error && <p className="saved-environment-error">{computer.error}</p>}
      {computer.checkedAt && (
        <p className="saved-environment-received">Last received {timestamp(computer.checkedAt)}</p>
      )}
      {removing && (
        <Dialog
          title="Remove environment?"
          description="Saved evidence and this connection will be removed. If the PC is offline, revoke this client's access there as well."
          onClose={() => setRemoving(false)}
        >
          <div className="row-actions">
            <Button onClick={() => setRemoving(false)} disabled={disabled}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={disabled}
              onClick={() => {
                void change(
                  "computers/remove",
                  { id: computer.id },
                  "Environment removed. Revoke access on the other PC if it was offline.",
                ).then((result) => {
                  if (result) setRemoving(false);
                });
              }}
            >
              Remove environment
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function ConnectionsSettings() {
  const { snapshot: app, change, discovering, discover } = useApplication();
  const { snapshot, busy, connection, mutate } = useMonitoring();
  const [addOpen, setAddOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("");
  const [invite, setInvite] = useState<ReturnType<typeof decodeInvitation> | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!invite) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invite]);
  if (!app || !snapshot) return null;
  const disabled = busy || connection !== "connected";
  const chosen = address || app.sharing.address || app.networkAddresses[0] || "";
  const chosenPort = port || String(app.sharing.port);
  const tailnetAddress = app.networkAddresses.find((a) => a.startsWith("100."));
  const origin = app.sharing.enabled ? `https://${app.sharing.address}:${app.sharing.port}` : null;
  const remaining = invite
    ? Math.max(0, Math.ceil((Date.parse(invite.expiresAt) - clock) / 1000))
    : 0;
  const pairing = invite ? parsePairingInvitation(invite.invitation) : null;
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => setCopyMessage("Copied."),
      () => setCopyMessage("Select the field and copy it manually."),
    );
  };
  const makeInvitation = () => {
    void mutate("/api/application/invitation", {}, decodeInvitation, "Pairing link created.").then(
      (result) => {
        if (result) {
          setInvite(result);
          setClock(Date.now());
          setCopyMessage(null);
        }
      },
    );
  };
  const openNetwork = (next?: string) => {
    setAddress(next ?? app.sharing.address ?? "");
    setPort(String(app.sharing.port));
    setNetworkOpen(true);
  };
  const updateLabel =
    app.update.status === "current"
      ? "Up to date"
      : app.update.status === "available"
        ? `v${app.update.latestVersion} available`
        : app.update.status === "checking"
          ? "Checking…"
          : app.update.status === "unpublished"
            ? "No published release"
            : app.update.status === "failed"
              ? "Check failed"
              : "Check for updates";
  return (
    <div className="connections-settings">
      <SettingGroup
        title={
          <span className="environment-section-title">
            <Monitor size={16} aria-hidden />
            {snapshot.device.label}
          </span>
        }
        action={
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="utility-button"
                  aria-label="More actions for this machine"
                />
              }
            >
              <Ellipsis size={15} aria-hidden />
            </MenuTrigger>
            <MenuPopup>
              <MenuItem
                disabled={disabled || discovering}
                onClick={() => {
                  void discover();
                }}
              >
                Refresh connections
              </MenuItem>
              <MenuItem
                disabled={disabled || !app.sharing.enabled || !!app.sharing.error}
                onClick={makeInvitation}
              >
                Create pairing link
              </MenuItem>
              <MenuItem disabled={disabled} onClick={() => openNetwork()}>
                Configure network access
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      >
        <SettingRow
          label="Local environment"
          description="Scan selected sources on this computer. Turn off to pause scheduled scans; manual scans remain available."
        >
          <Switch
            aria-label="Local environment"
            checked={!snapshot.settings.paused}
            disabled={disabled}
            onCheckedChange={(enabled) => {
              void mutate(
                "/api/settings",
                { paused: !enabled },
                decodeMonitoringSettings,
                enabled ? "Local scheduled scans resumed." : "Local scheduled scans paused.",
                "PATCH",
              );
            }}
          />
        </SettingRow>
        <SettingRow
          label="Version"
          description={`${app.update.currentVersion} · ${app.localOrigin ?? (window.location.protocol === "versionstead:" ? "Local coordinator" : window.location.origin)}`}
        >
          <Button
            variant="ghost"
            className="connection-version-status"
            disabled={disabled || app.update.status === "checking"}
            onClick={() => {
              void change("update", {}, "Versionstead release check finished.");
            }}
          >
            {updateLabel}
          </Button>
        </SettingRow>
        <SettingRow
          label="Network access"
          description={
            app.sharing.error ??
            (origin ? `${origin} · Paired devices only.` : "Limited to this machine.")
          }
        >
          <div className="row-actions">
            {origin && (
              <Button variant="ghost" disabled={disabled} onClick={makeInvitation}>
                Pair device
              </Button>
            )}
            <Switch
              aria-label="Enable network access"
              checked={app.sharing.enabled}
              disabled={disabled || !app.credentialStorageAvailable}
              onCheckedChange={() => openNetwork()}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="Tailscale HTTPS"
          description={
            tailnetAddress
              ? `Encrypted pairing through ${tailnetAddress}. Both PCs must be on your tailnet.`
              : app.tools.tailscale.available
                ? "Sign in to Tailscale to connect your PCs across networks."
                : "Start Tailscale to connect your PCs across networks."
          }
        >
          {tailnetAddress ? (
            <Button variant="ghost" disabled={disabled} onClick={() => openNetwork(tailnetAddress)}>
              {app.sharing.enabled && app.sharing.address === tailnetAddress
                ? "Configure"
                : "Set up"}
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="utility-button"
              aria-label="Refresh network connections"
              disabled={disabled || discovering}
              onClick={() => {
                void discover();
              }}
            >
              <RefreshIcon size="sm" refreshing={discovering} aria-hidden />
            </Button>
          )}
        </SettingRow>
        <SettingRow
          label="Background monitoring"
          description={
            snapshot.runtime.host === "boot-task"
              ? "Windows boot host is configured. Verify connectivity and scan history after sign-out."
              : snapshot.runtime.mode === "background"
                ? "Background host. The app window can stay closed."
                : "Monitoring keeps running when the app window closes. Install the Windows boot host for access after sign-out."
          }
        >
          <span className="muted small">
            {snapshot.runtime.host === "boot-task"
              ? "Boot host"
              : snapshot.runtime.mode === "background"
                ? "Background host"
                : "Owner session"}
          </span>
        </SettingRow>
      </SettingGroup>
      {(app.sharing.enabled || app.sharing.clients.length > 0) && (
        <details className="authorized-clients">
          <summary>
            Authorized clients <span>{app.sharing.clients.length} paired · One-time links</span>
          </summary>
          <div className="setting-group">
            <SettingRow
              label="Pairing links"
              description="Create a single-use link for another PC. A new link replaces the previous unused link."
            >
              <Button
                disabled={disabled || !app.sharing.enabled || !!app.sharing.error}
                onClick={makeInvitation}
              >
                Create pairing link
              </Button>
            </SettingRow>
            {app.sharing.clients.map((client) => (
              <SettingRow
                key={client.id}
                label={client.label}
                searchable={false}
                description={`Paired ${timestamp(client.createdAt)}`}
              >
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    void change("computers/revoke", { id: client.id }, "Client access revoked.");
                  }}
                >
                  Revoke access
                </Button>
              </SettingRow>
            ))}
          </div>
        </details>
      )}
      <SettingGroup
        title="Environments"
        action={
          <Button
            variant="ghost"
            disabled={disabled || !app.credentialStorageAvailable}
            onClick={() => setAddOpen(true)}
          >
            <Plus size={13} aria-hidden /> Add environment
          </Button>
        }
      >
        {app.computers.length ? (
          app.computers.map((computer) => (
            <SavedEnvironment key={computer.id} computer={computer} disabled={disabled} />
          ))
        ) : (
          <div className="empty-environments">
            <span className="empty-environment-icon">
              <ChevronsLeftRightEllipsis size={20} aria-hidden />
            </span>
            <h3>No saved remote environments</h3>
            <p>
              Click “Add environment” to pair another
              <br />
              PC over your local network, Tailscale, or SSH.
            </p>
          </div>
        )}
      </SettingGroup>
      {addOpen && <AddEnvironmentDialog close={() => setAddOpen(false)} />}
      {networkOpen && (
        <Dialog
          title={app.sharing.enabled ? "Configure network access" : "Enable network access?"}
          description="Let paired devices read this PC's evidence and request scans of its selected sources."
          className="network-dialog"
          dismissible={!busy}
          onClose={() => setNetworkOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void change(
                "sharing",
                { enabled: true, address: chosen, port: Number(chosenPort) },
                "Network access enabled.",
                "PATCH",
              ).then((result) => {
                if (result) {
                  setInvite(null);
                  setNetworkOpen(false);
                }
              });
            }}
          >
            <div className="connection-input-grid remote">
              <div>
                <label className="field-label">Network address</label>
                <Choice
                  label="Sharing network address"
                  value={chosen}
                  items={[
                    ...new Set([
                      ...app.networkAddresses,
                      ...(app.sharing.address ? [app.sharing.address] : []),
                    ]),
                  ].map((value) => ({
                    value,
                    label: `${value}${value.startsWith("100.") ? " · Tailscale" : ""}`,
                  }))}
                  disabled={disabled}
                  onChange={setAddress}
                />
              </div>
              <label className="field-label">
                Port
                <Input
                  aria-label="Sharing port"
                  value={chosenPort}
                  onChange={(e) => setPort(e.target.value)}
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  disabled={disabled}
                />
              </label>
            </div>
            <p className="muted small">
              Allow the chosen port for trusted LAN or tailnet peers in Windows Firewall. A pairing
              link is still required.
            </p>
            {!chosen && (
              <p className="connection-form-error">
                No LAN or Tailscale IPv4 address was detected. Connect to your network and refresh.
              </p>
            )}
            {app.sharing.error && (
              <p className="connection-form-error" role="alert">
                {app.sharing.error}
              </p>
            )}
            <div className="row-actions">
              {(app.sharing.enabled || app.sharing.clients.length > 0) && (
                <Button
                  variant="danger"
                  disabled={disabled}
                  onClick={() => {
                    void change(
                      "sharing",
                      { enabled: false },
                      "Network access disabled. Pairing records are retained.",
                      "PATCH",
                    ).then((result) => {
                      if (result) {
                        setInvite(null);
                        setNetworkOpen(false);
                      }
                    });
                  }}
                >
                  Disable network access
                </Button>
              )}
              <Button disabled={disabled} onClick={() => setNetworkOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={disabled || !chosen}>
                {busy ? "Applying…" : app.sharing.enabled ? "Save" : "Enable"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {invite && pairing && app.sharing.enabled && (
        <Dialog
          title="Pair another device"
          description="Paste this link into Add Environment on the other PC. It grants evidence reads and selected-source scans."
          className="pair-device-dialog"
          onClose={() => {
            setInvite(null);
            setCopyMessage(null);
          }}
        >
          <label className="field-label">
            Pairing link
            <Input
              readOnly
              value={pairing.url}
              aria-label="Pairing link"
              onFocus={(e) => e.target.select()}
            />
          </label>
          <div className="row-actions">
            <Button disabled={!remaining} onClick={() => copy(pairing.url)}>
              <Copy size={14} aria-hidden />
              Copy link
            </Button>
            <Button variant="ghost" disabled={!remaining || disabled} onClick={makeInvitation}>
              Create new link
            </Button>
          </div>
          <p className="muted small" role="status">
            {remaining
              ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}. Single use.`
              : "This link has expired. Create a new link."}
          </p>
          <details className="pairing-manual">
            <summary>Enter host and code separately</summary>
            <label className="field-label">
              Host
              <Input readOnly value={pairing.host} onFocus={(e) => e.target.select()} />
            </label>
            <label className="field-label">
              Pairing code
              <Input
                readOnly
                type="password"
                value={pairing.pairingCode}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <Button disabled={!remaining} onClick={() => copy(pairing.pairingCode)}>
              Copy pairing code
            </Button>
          </details>
          {copyMessage && (
            <p role="status" className="muted small">
              {copyMessage}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
