export type ActionOptions = {
  /** What the action changes; a control that belongs to it is inactive while it runs. */
  key?: string | undefined;
  /** Receives the failure message for the caller to show in place, instead of a toast. */
  onError?: ((message: string) => void) | undefined;
};

/** Keys for the actions that controls disable themselves for, shared by every place that starts one. */
export const actionKeys = {
  session: "session",
  addProject: "project:add",
  removeProject: (projectId: string) => `project:remove:${projectId}`,
  projectMode: (projectId: string) => `project:mode:${projectId}`,
  scan: (target: string, projectId?: string) =>
    projectId ? `scan:${target}:${projectId}` : `scan:${target}`,
  setting: (field: string) => `setting:${field}`,
  preference: (field: string) => `preference:${field}`,
  provider: (kind: string) => `provider:${kind}`,
  client: (clientId: string) => `client:${clientId}`,
  environment: (computerId: string) => `environment:${computerId}`,
  sharing: "sharing",
  invitation: "invitation",
  update: "update",
};

/**
 * Delivers a failure message to the form that started the action while that form is open, and to a
 * fallback (a toast) once it is not, so closing a form before its request settles loses nothing.
 */
export function failureRouter(
  show: (message: string) => void,
  fallback: (message: string) => void,
) {
  let open = true;
  return {
    setOpen(next: boolean) {
      open = next;
    },
    deliver(message: string) {
      (open ? show : fallback)(message);
    },
  };
}

/** The keys still pending once one action with this key finishes; an overlapping one keeps it. */
export function settled(keys: readonly string[], key: string): readonly string[] {
  const index = keys.indexOf(key);
  return index < 0 ? keys : keys.toSpliced(index, 1);
}
