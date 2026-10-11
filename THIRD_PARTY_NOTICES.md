# Third-party notices

Versionstead includes code adapted from the projects below. Each is used under the license that follows its entry.

## T3 Code

Source: https://github.com/pingdotgg/t3code

- Components in `apps/web/src/components/ui`, `apps/web/src/lib/utils.ts`, `apps/web/src/appearance-previews.tsx`, `apps/web/src/appearance-settings.tsx`, and the discovery-row layout in `apps/web/src/components/source-control-row.tsx` are adapted from T3 Code.
- Provider and VCS icons in `apps/web/src/components/source-control-icons.tsx` are copied from T3 Code `Icons.tsx`. Theme palette values in `apps/web/src/theme-palettes.ts` are adapted from `packages/shared/src/themePalettes.ts`.
- Account redaction, tooltip/refresh components, visible-animation handling, and the Add Project source/back/confirmation flow are adapted from T3 Code.
- Connections section layout, environment mode cards, pairing dialog structure, and menu interactions are adapted from T3 Code `ConnectionsSettings.tsx` and its Base UI menu.
- Native caption geometry/appearance and window restoration in `apps/desktop/src/window.ts`, and the settings search, breadcrumb, sidebar, and return navigation patterns are adapted from T3 Code `DesktopWindow.ts`, `WorkspacePageHeader.tsx`, `SettingsSidebarNav.tsx`, and `settings.tsx`.
- Project settings layout, icon picker/editor flow, action editor/list, and identity/color helpers are adapted from T3 Code `ProjectSettingsPanel.tsx`, `ProjectActionsSettings.tsx`, `ProjectIconPickerDialog.tsx`, `projectScriptEditor.tsx`, and `projectIdentity.ts`.
- The global tool **Update now** control and Windows CLI fallback directories are adapted from T3 Code `ProviderInstanceCard.tsx`, `providerMaintenance.ts`, `providerMaintenanceRunner.ts`, and `packages/shared/src/shell.ts`.

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn/ui

Source: https://ui.shadcn.com/docs/components/base/toast

The toast component in `apps/web/src/components/ui/toast.tsx` is adapted from shadcn/ui's Base UI `base-mira` registry.

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
