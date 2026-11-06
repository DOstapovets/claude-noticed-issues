import type { Hook } from 'claude-code'

export type Api = Parameters<Hook<'tool.call'>>[0]

export const MINUTE = 60_000

export const session = {
  // Set by session.start, which also runs again on every reload.
  cwd: '',
  storeKey: '',
  nextId: 1,
  // The repository's `origin`, kept with the list so the Projects tab of another project can name it.
  remote: undefined as string | undefined,
  // Whether this session offers GitHub issues and reads their status.
  github: false,
  // The pane's width as last drawn: `ui.scroll` does not carry it.
  paneColumns: 60,
  // Whether the pane was last drawn on the terminal, the one surface whose rows the
  // layout can count: `ui.scroll` does not say where it comes from either.
  paneOnTerminal: true,
  // Whether the pane was last drawn in the terminal's fullscreen layout, for feedback from its button.
  paneFullscreen: undefined as boolean | undefined,
}
